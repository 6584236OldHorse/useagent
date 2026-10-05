import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn, SpawnOptions } from "node:child_process";
import { createRunnerController, stopRunnerBeforeQuit } from "./runner";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  closeOnKill = true;
  killResult = true;

  kill(): boolean {
    this.killed = true;
    if (this.closeOnKill) queueMicrotask(() => this.close(0));
    return this.killResult;
  }

  close(code: number): void {
    this.exitCode = code;
    this.emit("close", code, null);
  }
}

function fakeSpawn() {
  const calls: Array<{ file: string; args: string[]; options: SpawnOptions; child: FakeChild }> = [];
  const spawnRunner = ((file: string, args: string[], options: SpawnOptions) => {
    const child = new FakeChild();
    calls.push({ file, args, options, child });
    return child;
  }) as unknown as typeof spawn;
  return { calls, spawnRunner };
}

describe("runner controller", () => {
  test("passes the token only through the environment and parses bounded status lines", async () => {
    const ambient = {
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GH_TOKEN: process.env.GH_TOKEN,
    };
    process.env.BETTER_AUTH_SECRET = "ambient-auth-secret";
    process.env.OPENAI_API_KEY = "ambient-provider-secret";
    process.env.GH_TOKEN = "ambient-github-secret";
    const fake = fakeSpawn();
    const controller = createRunnerController(
      { binary: "/runner", plane: "https://plane.example", backend: "auto", shareLogins: ["opencode", "codex"] },
      fake.spawnRunner,
    );

    await controller.start("secret-token");
    const call = fake.calls[0]!;
    expect(call.file).toBe("/runner");
    expect(call.args).toEqual([
      "--plane",
      "https://plane.example",
      "--backend",
      "auto",
      "--share-logins",
      "codex,opencode",
    ]);
    expect(call.args.join(" ")).not.toContain("secret-token");
    expect(call.options?.shell).toBe(false);
    expect(call.options?.env?.USEAGENT_RUNNER_TOKEN).toBe("secret-token");
    expect(call.options?.env?.HOME).toBe(process.env.HOME);
    try {
      expect(call.options?.env?.BETTER_AUTH_SECRET).toBeUndefined();
      expect(call.options?.env?.OPENAI_API_KEY).toBeUndefined();
      expect(call.options?.env?.GH_TOKEN).toBeUndefined();
    } finally {
      for (const [name, value] of Object.entries(ambient)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    call.child.stdout.write('{"state":"pull');
    call.child.stdout.write('ing","detail":"Downloading","progress":0.4,"token":"payload-secret"}\n');
    expect(controller.getStatus()).toEqual({ state: "pulling", detail: "Downloading", progress: 0.4 });

    call.child.stdout.write('{"state":"online","detail":"secret-token","progress":2}\n');
    expect(controller.getStatus()).toEqual({
      state: "error",
      detail: "Runner sent an invalid status update.",
      progress: 0,
    });
    call.child.stdout.write("not json\n");
    call.child.stdout.write('{"state":"online","detail":"Ready without progress"}\n');
    expect(controller.getStatus()).toEqual({ state: "online", detail: "Ready without progress", progress: 0 });
    call.child.stdout.write('{"state":"online","detail":"Bad progress","progress":"1"}\n');
    expect(controller.getStatus()).toEqual({
      state: "error",
      detail: "Runner sent an invalid status update.",
      progress: 0,
    });
    call.child.stdout.write('{"state":"online","detail":"Ready","progress":1}\n');
    expect(controller.getStatus()).toEqual({ state: "online", detail: "Ready", progress: 1 });
    call.child.stdout.write(`${"x".repeat(65 * 1024)}\n`);
    expect(controller.getStatus().detail).not.toContain("secret-token");
    await controller.stop();
  });

  test("waits for the old child before restart and stop leaves no restart behind", async () => {
    const fake = fakeSpawn();
    const controller = createRunnerController({ binary: "/runner", plane: "https://plane.example" }, fake.spawnRunner);
    await controller.start("first");
    fake.calls[0]!.child.closeOnKill = false;

    const restarting = controller.restart("second");
    await Promise.resolve();
    expect(fake.calls).toHaveLength(1);
    fake.calls[0]!.child.close(0);
    await restarting;
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.options?.env?.USEAGENT_RUNNER_TOKEN).toBe("second");
    fake.calls[1]!.child.stdout.write('{"state":"online","detail":"Current","progress":1}\n');
    fake.calls[0]!.child.stdout.write('{"state":"error","detail":"Stale","progress":0}\n');
    expect(controller.getStatus()).toEqual({ state: "online", detail: "Current", progress: 1 });

    await controller.stop();
    expect(fake.calls[1]!.child.killed).toBe(true);
    expect(controller.getStatus().state).toBe("offline");
    await Bun.sleep(1_050);
    expect(fake.calls).toHaveLength(2);
  });

  test("failed termination blocks replacement and quit until a retry succeeds", async () => {
    const fake = fakeSpawn();
    const controller = createRunnerController({ binary: "/runner", plane: "https://plane.example" }, fake.spawnRunner);
    await controller.start("first");
    fake.calls[0]!.child.closeOnKill = false;
    fake.calls[0]!.child.killResult = false;

    await expect(controller.restart("second")).rejects.toThrow("Runner did not stop.");
    expect(fake.calls).toHaveLength(1);

    let quitCalled = false;
    await expect(stopRunnerBeforeQuit(() => controller.stop(), () => { quitCalled = true; })).rejects.toThrow("Runner did not stop.");
    expect(quitCalled).toBe(false);
    expect(fake.calls).toHaveLength(1);

    fake.calls[0]!.child.killResult = true;
    fake.calls[0]!.child.closeOnKill = true;
    await controller.restart("second");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.options?.env?.USEAGENT_RUNNER_TOKEN).toBe("second");
    await controller.stop();
  });

  test("restarts crashes with backoff", async () => {
    const fake = fakeSpawn();
    const controller = createRunnerController({ binary: "/runner", plane: "https://plane.example" }, fake.spawnRunner);
    await controller.start("secret-token");
    fake.calls[0]!.child.close(9);

    expect(controller.getStatus()).toEqual({
      state: "offline",
      detail: "Runner stopped unexpectedly. Restarting in 1s.",
      progress: 0,
    });
    await Bun.sleep(1_050);
    expect(fake.calls).toHaveLength(2);
    fake.calls[1]!.child.stdout.write('{"state":"online","detail":"Ready","progress":1}\n');
    fake.calls[1]!.child.close(9);
    expect(controller.getStatus().detail).toBe("Runner stopped unexpectedly. Restarting in 2s.");
    await controller.stop();
  });

  test("terminal exits do not restart and token rejection is actionable", async () => {
    const errors = [
      "The runner command is invalid. Reinstall the desktop app.",
      "The runner token was rejected. Connect this machine again.",
      "No supported container backend is available.",
      "The control plane must be updated before this runner can connect.",
      "The runner must be updated before it can connect to this control plane.",
    ];
    const controllers: Array<{ calls: ReturnType<typeof fakeSpawn>["calls"] }> = [];
    const fake = fakeSpawn();
    let rejected = 0;
    for (const [index, detail] of errors.entries()) {
      const current = index === 1 ? fake : fakeSpawn();
      const controller = createRunnerController(
        { binary: "/runner", plane: "https://plane.example", onTokenRejected: () => rejected++ },
        current.spawnRunner,
      );
      await controller.start("secret-token");
      current.calls[0]!.child.stderr.write("secret-token");
      current.calls[0]!.child.close(index + 1);
      expect(controller.getStatus()).toEqual({ state: "error", detail, progress: 0 });
      controllers.push(current);
    }
    expect(rejected).toBe(1);
    await Bun.sleep(1_050);
    for (const current of controllers) expect(current.calls).toHaveLength(1);
  });

  test("a missing packaged runner is terminal and actionable", async () => {
    const fake = fakeSpawn();
    const controller = createRunnerController({ binary: "/missing-runner", plane: "https://plane.example" }, fake.spawnRunner);
    await controller.start("secret-token");
    const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    fake.calls[0]!.child.emit("error", error);

    expect(controller.getStatus()).toEqual({
      state: "error",
      detail: "Runner binary is missing. Reinstall the desktop app.",
      progress: 0,
    });
    await Bun.sleep(1_050);
    expect(fake.calls).toHaveLength(1);
  });
});
