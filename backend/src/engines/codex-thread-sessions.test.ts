import { afterEach, describe, expect, test } from "bun:test";
import {
  claimCodexThreadSession,
  codexThreadSessionKey,
  evictCodexThreadSession,
  keepCodexThreadSession,
  liveCodexThreadSessions,
  releaseCodexThreadSession,
  resetCodexThreadSessionsForTest,
} from "./codex-thread-sessions";

const closed: string[] = [];
const parts = (name: string) => ({ environmentId: `env-${name}`, close: () => void closed.push(name) });
const key = (user: string, thread: string) => codexThreadSessionKey({
  orgId: "org", userId: user, threadId: thread, sandboxId: `sbx-${thread}`, connectionId: "conn", authEpoch: "epoch",
});

afterEach(() => {
  resetCodexThreadSessionsForTest();
  closed.length = 0;
});

describe("kept Codex thread sessions", () => {
  test("hands a released session to the next run, never to two runs at once", () => {
    const kept = keepCodexThreadSession(key("u", "t"), "u", parts("t"))!;
    expect(claimCodexThreadSession(key("u", "t"))).toBeNull();
    releaseCodexThreadSession(kept);
    const claimed = claimCodexThreadSession(key("u", "t"));
    expect(claimed).toBe(kept);
    expect(claimCodexThreadSession(key("u", "t"))).toBeNull();
    expect(closed).toEqual([]);
  });

  test("keeps four per user, evicting that user's least recently used idle session", () => {
    let clock = 0;
    resetCodexThreadSessionsForTest({ clock: () => clock });
    const sessions = ["a", "b", "c", "d"].map((thread) => {
      clock += 1;
      return keepCodexThreadSession(key("u1", thread), "u1", parts(`u1/${thread}`))!;
    });
    expect(keepCodexThreadSession(key("u2", "x"), "u2", parts("u2/x"))).not.toBeNull();
    expect(keepCodexThreadSession(key("u1", "e"), "u1", parts("u1/e"))).toBeNull();
    clock = 10;
    releaseCodexThreadSession(sessions[2]!);
    clock = 20;
    releaseCodexThreadSession(sessions[0]!);
    expect(keepCodexThreadSession(key("u1", "e"), "u1", parts("u1/e"))).not.toBeNull();
    expect(closed).toEqual(["u1/c"]);
    expect(liveCodexThreadSessions()).toBe(5);
  });

  test("keeps forty overall, evicting the least recently used idle session of anyone", () => {
    let clock = 0;
    resetCodexThreadSessionsForTest({ clock: () => clock });
    const sessions = Array.from({ length: 40 }, (_, index) => {
      clock += 1;
      return keepCodexThreadSession(key(`user-${index}`, "t"), `user-${index}`, parts(`user-${index}`))!;
    });
    expect(keepCodexThreadSession(key("late", "t"), "late", parts("late"))).toBeNull();
    clock = 100;
    releaseCodexThreadSession(sessions[7]!);
    expect(keepCodexThreadSession(key("late", "t"), "late", parts("late"))).not.toBeNull();
    expect(closed).toEqual(["user-7"]);
    expect(liveCodexThreadSessions()).toBe(40);
  });

  test("evicts a session that idled past its window, and on demand", async () => {
    resetCodexThreadSessionsForTest({ idleMs: 20 });
    const idle = keepCodexThreadSession(key("u", "idle"), "u", parts("idle"))!;
    keepCodexThreadSession(key("u", "broken"), "u", parts("broken"));
    releaseCodexThreadSession(idle);
    await Bun.sleep(60);
    expect(closed).toEqual(["idle"]);
    evictCodexThreadSession(key("u", "broken"), "unusable");
    expect(closed).toEqual(["idle", "broken"]);
    expect(liveCodexThreadSessions()).toBe(0);
  });

  test("a claim stops the idle clock", async () => {
    resetCodexThreadSessionsForTest({ idleMs: 30 });
    const kept = keepCodexThreadSession(key("u", "t"), "u", parts("t"))!;
    releaseCodexThreadSession(kept);
    expect(claimCodexThreadSession(key("u", "t"))).toBe(kept);
    await Bun.sleep(60);
    expect(closed).toEqual([]);
  });
});
