import { describe, expect, test } from "bun:test";
import {
  applyNativeImage,
  desktopToolchainCommand,
  isNativeImageName,
  nativeImageName,
  nativeImageSteps,
  renderNativeImageDockerfile,
  type NativeImageInputs,
} from "./native-image";
import type { SandboxRuntimeLayout } from "./provider";

const BOX_LAYOUT: SandboxRuntimeLayout = {
  home: "/home/user",
  workdir: "/home/user/work",
  bunExecutable: "/usr/local/bin/bun",
  runsAsRoot: false,
};
const CUBE_LAYOUT: SandboxRuntimeLayout = {
  home: "/root",
  workdir: "/root/work",
  bunExecutable: "/usr/local/bin/bun",
  runsAsRoot: true,
};

function inputs(overrides: Partial<NativeImageInputs> = {}): NativeImageInputs {
  return {
    bun: { bytes: Buffer.from("bun-binary"), arch: "x64" },
    runtimeArchive: Buffer.from("archive"),
    runtimeDependencyLock: Buffer.from("lock"),
    runtimeDependencyPackage: Buffer.from("{}"),
    piPackage: Buffer.from("{}"),
    piLock: Buffer.from("{}"),
    claudeEnvironment: { ANTHROPIC_BASE_URL: "https://gateway.example/anthropic", CLAUDE_CONFIG_DIR: "/home/user/.useagent/claude" },
    ...overrides,
  };
}

describe("native image name", () => {
  test("is a fingerprint of the inputs and recognisable as ours", () => {
    const name = nativeImageName(inputs());
    expect(name).toMatch(/^useagent-native-[0-9a-f]{7}-[0-9a-f]{10}$/);
    expect(isNativeImageName(name)).toBe(true);
    expect(nativeImageName(inputs())).toBe(name);
    expect(nativeImageName(inputs({ claudeEnvironment: {} }))).not.toBe(name);
  });

  test("rejects other snapshot names", () => {
    expect(isNativeImageName("useagent-opencode-1-18-7")).toBe(false);
    expect(isNativeImageName("")).toBe(false);
    expect(isNativeImageName(null)).toBe(false);
  });
});

describe("native image steps", () => {
  test("repairs missing desktop tools and refuses an incomplete installation", async () => {
    for (const repaired of [true, false]) {
      const child = Bun.spawn(["bash", "-c", `
installed=0
command() {
  case "$2" in
    xdotool|pcmanfm) [ "$installed" = 1 ] ;;
    *) return 0 ;;
  esac
}
test() { [ "$1" = -r ] && [ "$2" = /usr/share/novnc/vnc.html ]; }
apt-get() {
  case " $* " in
    *" install "*)
      case " $* " in *" xdotool "*) ;; *) return 1 ;; esac
      case " $* " in *" budgie-core "*) ;; *) return 1 ;; esac
      case " $* " in *" xserver-xorg-video-dummy "*) ;; *) return 1 ;; esac
      echo installed-desktop-tools
      installed=${repaired ? 1 : 0}
      ;;
  esac
}
rm() { :; }
install() { :; }
tee() { cat >/dev/null; }
chmod() { :; }
dconf() { :; }
gtk-update-icon-cache() { :; }
set -eu
${desktopToolchainCommand(CUBE_LAYOUT)}
`], { stdout: "pipe", stderr: "pipe" });
      const [output, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(stderr).toBe("");
      expect(output).toContain("installed-desktop-tools");
      expect(exitCode === 0).toBe(repaired);
    }
  });

  test("cover bun, the runtime, every driver, Pi, documents and desktop in order", () => {
    const steps = nativeImageSteps(BOX_LAYOUT, inputs());
    expect(steps.map((step) => step.name)).toEqual([
      "bun", "native-runtime", "codex", "claude", "opencode", "boot", "pi", "documents", "desktop",
    ]);
    for (const step of steps) {
      expect(step.command.startsWith("set -eu\nexport HOME='/home/user'\n")).toBe(true);
    }
  });

  test("skip the Claude driver when no provider gateway is configured", () => {
    const steps = nativeImageSteps(BOX_LAYOUT, inputs({ claudeEnvironment: {} }));
    expect(steps.map((step) => step.name)).not.toContain("claude");
  });

  test("place files under the layout's home and probe before installing", () => {
    const steps = nativeImageSteps(BOX_LAYOUT, inputs());
    const runtime = steps.find((step) => step.name === "native-runtime")!;
    expect(runtime.files.map((file) => file.path)).toEqual([
      "/home/user/.local/share/useagent/native-runtime/.stage-image/dependencies/bun.lock",
      "/home/user/.local/share/useagent/native-runtime/.stage-image/dependencies/package.json",
      "/home/user/.local/share/useagent/native-runtime/.stage-image/runtime.part-0",
    ]);
    const condition = runtime.command.split("\n").find((line) => line.startsWith("if "))!;
    expect(condition).not.toContain("#");
    expect(condition).toContain("exit 0; fi");
    const pi = steps.find((step) => step.name === "pi")!;
    expect(pi.files.map((file) => file.path)).toEqual([
      "/home/user/.useagent/pi-runtime/manifest/package.json",
      "/home/user/.useagent/pi-runtime/manifest/package-lock.json",
    ]);
    expect(pi.command).toContain("/usr/local/bin/bun");
  });

  test("use sudo for the document toolchain only when the sandbox runs unprivileged", () => {
    const box = nativeImageSteps(BOX_LAYOUT, inputs()).find((step) => step.name === "documents")!;
    const cube = nativeImageSteps(CUBE_LAYOUT, inputs()).find((step) => step.name === "documents")!;
    expect(box.command).toContain("sudo -n apt-get install");
    expect(cube.command).toContain("\napt-get install");
    expect(cube.command).not.toContain("sudo");
    const piOnCube = nativeImageSteps(CUBE_LAYOUT, inputs()).find((step) => step.name === "pi")!;
    expect(piOnCube.files[0]!.path).toBe("/opt/useagent/pi-runtime/manifest/package.json");
  });
});

describe("native image Dockerfile", () => {
  test("stages the context with one COPY and runs every step from the base image argument", () => {
    const rendered = renderNativeImageDockerfile(CUBE_LAYOUT, inputs());
    expect(rendered.dockerfile.startsWith(`# ${nativeImageName(inputs())}`)).toBe(true);
    expect(rendered.dockerfile).toContain("ARG USEAGENT_NATIVE_BASE_IMAGE\nFROM ${USEAGENT_NATIVE_BASE_IMAGE}\nUSER root\n");
    expect(rendered.dockerfile).toContain("RUN mkdir -p /root/work\nCOPY context/ /tmp/useagent-native-image/\n");
    expect(rendered.files.map((file) => file.contextPath)).toEqual([
      "context/0-bun/bun",
      "context/0-bun.sh",
      "context/1-native-runtime/bun.lock",
      "context/1-native-runtime/package.json",
      "context/1-native-runtime/runtime.part-0",
      "context/1-native-runtime.sh",
      "context/2-codex.sh",
      "context/3-claude.sh",
      "context/4-opencode.sh",
      "context/5-boot/useagent-sandbox-boot",
      "context/5-boot.sh",
      "context/6-pi/package.json",
      "context/6-pi/package-lock.json",
      "context/6-pi.sh",
      "context/7-documents.sh",
      "context/8-desktop.sh",
    ]);
    // Every layer on top of the base: the workdir, the staged context, one RUN per step, the cleanup.
    // The base image already carries over a hundred layers; the runtime rejects images past its depth limit.
    const steps = nativeImageSteps(CUBE_LAYOUT, inputs());
    const layers = rendered.dockerfile.split("\n").filter((line) => /^(COPY|RUN)\b/.test(line));
    expect(layers.filter((line) => line.startsWith("COPY"))).toEqual(["COPY context/ /tmp/useagent-native-image/"]);
    expect(layers.filter((line) => line.startsWith("RUN sh "))).toEqual(steps.map((step, index) =>
      `RUN sh /tmp/useagent-native-image/${index}-${step.name}.sh && rm -rf /tmp/useagent-native-image/${index}-${step.name}.sh /tmp/useagent-native-image/${index}-${step.name}`,
    ));
    expect(layers).toHaveLength(steps.length + 3);
    expect(layers.at(-1)).toBe("RUN rm -rf /tmp/useagent-native-image");
    expect(rendered.dockerfile).not.toContain("<<");
    // The image boots its runtime: the entrypoint is the installed boot script.
    expect(rendered.dockerfile.trimEnd().endsWith('ENTRYPOINT ["/root/.local/bin/useagent-sandbox-boot"]')).toBe(true);
    // The base image's command survives the entrypoint when the bake knows it; a provider daemon may live there.
    const withCommand = renderNativeImageDockerfile(CUBE_LAYOUT, inputs(), undefined, process.env, ["/usr/local/bin/start-sandbox.sh"]);
    expect(withCommand.dockerfile.trimEnd().endsWith('ENTRYPOINT ["/root/.local/bin/useagent-sandbox-boot"]\nCMD ["/usr/local/bin/start-sandbox.sh"]')).toBe(true);
    const boot = rendered.files.find((file) => file.contextPath === "context/5-boot/useagent-sandbox-boot")!;
    expect(boot.bytes.toString("utf8").startsWith("#!/bin/sh\n")).toBe(true);
    const bun = rendered.files.find((file) => file.contextPath === "context/0-bun.sh")!;
    expect(bun.bytes.toString("utf8").startsWith(
      "set -eu\nmkdir -p '/root/.local/share/useagent/bun/.stage-image' && cp '/tmp/useagent-native-image/0-bun/bun' '/root/.local/share/useagent/bun/.stage-image/bun'\nset -eu\nexport HOME='/root'\n",
    )).toBe(true);
    const documents = rendered.files.find((file) => file.contextPath === "context/7-documents.sh")!;
    expect(documents.bytes.toString("utf8").startsWith("set -eu\nset -eu\nexport HOME='/root'\n")).toBe(true);
    expect(rendered.dockerfile).toContain(`LABEL org.useagent.native-image=${nativeImageName(inputs())}\n`);
  });

  test("hands the staged context to the runtime user when the sandbox runs unprivileged", () => {
    const rendered = renderNativeImageDockerfile(BOX_LAYOUT, inputs());
    expect(rendered.dockerfile).toContain("\nCOPY --chown=1000:1000 context/ /tmp/useagent-native-image/\n");
    expect(rendered.dockerfile).not.toContain("USER root");
  });
});

describe("applying the native image to a live sandbox", () => {
  function fakeTarget(exitCodes: Record<string, number> = {}) {
    const uploads: { path: string; bytes: number }[] = [];
    const commands: string[] = [];
    return {
      uploads,
      commands,
      target: {
        process: {
          async executeCommand(command: string) {
            commands.push(command);
            const step = Object.keys(exitCodes).find((name) => command.includes(`${name} `) || command.includes(name));
            return { exitCode: step ? exitCodes[step]! : 0, result: "" };
          },
        },
        fs: {
          async uploadFile(bytes: Buffer, path: string) {
            uploads.push({ path, bytes: bytes.length });
          },
        },
      },
    };
  }

  test("uploads each step's files, splitting large ones into parts, then runs the step", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 5, 1);
    const fake = fakeTarget();
    await applyNativeImage(fake.target, BOX_LAYOUT, inputs({ bun: { bytes: big, arch: "x64" } }), {
      signal: new AbortController().signal,
    });
    const bunUploads = fake.uploads.filter((upload) => upload.path.includes("/bun/.stage-image/bun"));
    expect(bunUploads.map((upload) => upload.path.slice(upload.path.lastIndexOf("/") + 1))).toEqual(["bun.part-0", "bun.part-1"]);
    expect(bunUploads.map((upload) => upload.bytes)).toEqual([3 * 1024 * 1024, 5]);
    expect(fake.commands.some((command) => command.includes("cat ") && command.includes("bun.part-0") && command.includes("bun.part-1"))).toBe(true);
    const stepCommands = fake.commands.filter((command) => command.startsWith("set -eu\nexport HOME="));
    expect(stepCommands).toHaveLength(9);
    expect(fake.uploads.at(-1)!.path).toBe("/home/user/.useagent/pi-runtime/manifest/package-lock.json");
  });

  test("names the failing step", async () => {
    const fake = fakeTarget({ "apt-get": 100 });
    await expect(
      applyNativeImage(fake.target, BOX_LAYOUT, inputs(), { signal: new AbortController().signal }),
    ).rejects.toThrow(/^documents failed \(exit 100\)/);
  });
});
