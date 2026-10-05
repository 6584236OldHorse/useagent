import { afterEach, describe, expect, test } from "bun:test";
import sharp from "sharp";
import type { ArtifactDescriptor } from "../../artifacts/repo";
import { type ComputerSequenceAction, describeSequenceFailure, sequenceBatches } from "./computer-use-tools";
import { addressBarNavigateCommand } from "./computer-use-shell";
import type { SandboxHandle } from "../../sandboxes/provider";
import { setSandboxArtifactPublisherForTest } from "./artifact-tools";
import {
  buildCubeSequenceCommand,
  captureSandboxScreenshot,
  COMPUTER_USE_TOOL_NAMES,
  COMPUTER_USE_TOOLS,
  type ComputerToolContent,
  executeComputerUseTool,
  screenshotArtifactHandoff,
  setComputerUseServiceForTest,
  x11HotkeyCommand,
  x11KeyCommand,
  x11KeyName,
} from "./computer-use-tools";
import { MODEL_SCREENSHOT_MAX_BYTES } from "./screenshot-compression";
import type { ToolTokenClaims } from "./token";

const claims: ToolTokenClaims = {
  orgId: "org-1",
  userId: "user-1",
  threadId: "thread-1",
  runId: "run-1",
  scope: "run",
  exp: Date.now() + 60_000,
};

test("builds fail-fast Cube action batches", () => {
  expect(buildCubeSequenceCommand([
    { action: "hotkey", keys: "ctrl+l" },
    { action: "type", text: "https://example.com", delayMs: 0 },
    { action: "key", key: "Enter", modifiers: [], repeat: 1 },
  ])).toContain(" && ");
  // After the coordinate prefix, the chain is fail-fast with a marker after every action.
  const chain = buildCubeSequenceCommand([
    { action: "wait", ms: 0 },
    { action: "wait", ms: 0 },
  ]).split("dw=$sw; ")[1]!;
  expect(chain).not.toContain("; ");
  expect(chain).toBe("sleep 0.000 && printf '%s\\n' USEAGENT_STEP_OK_1 && sleep 0.000 && printf '%s\\n' USEAGENT_STEP_OK_2");
});

describe("coordinates, richer actions and failures", () => {
  test("coordinates are screenshot pixels scaled to the display at run time", () => {
    const command = buildCubeSequenceCommand(
      [{ action: "click", x: 640, y: 360, button: "left", double: false, triple: false, modifiers: [] }],
      { display: ":1", screenshotWidth: 1280 },
    );
    expect(command).toContain("sw=1280; dw=$(xdpyinfo -display :1");
    expect(command).toContain("xdotool mousemove $((640*dw/sw)) $((360*dw/sw)) click 1");
    expect(Bun.spawnSync(["bash", "-c", `sw=1280; dw=1920; echo $((640*dw/sw)) $((360*dw/sw))`]).stdout.toString().trim()).toBe("960 540");
  });

  test("triple click, modifier click, key repeat, hold and horizontal scroll", () => {
    const command = buildCubeSequenceCommand([
      { action: "click", x: 1, y: 2, button: "left", double: false, triple: true, modifiers: ["shift"] },
      { action: "key", key: "Down", modifiers: [], repeat: 3 },
      { action: "hold_key", key: "space", durationMs: 1500 },
      { action: "scroll", x: 5, y: 6, direction: "right", amount: 2 },
    ]);
    expect(command).toContain("xdotool keydown shift && xdotool mousemove $((1*dw/sw)) $((2*dw/sw)) click --repeat 3 --delay 80 1; status=$?; xdotool keyup shift; test $status -eq 0");
    expect(command).toContain("for _i in $(seq 1 3); do {");
    expect(command).toContain("xdotool keydown --clearmodifiers space && sleep 1.500; xdotool keyup space");
    expect(command).toContain("click --repeat 2 --delay 40 7");
    expect(Bun.spawnSync(["bash", "-n", "-c", command]).exitCode).toBe(0);
  });

  test("long text is pasted through the clipboard with a keystroke fallback", () => {
    const short = buildCubeSequenceCommand([{ action: "type", text: "hello", delayMs: 10 }]);
    expect(short).not.toContain("xclip");
    const long = buildCubeSequenceCommand([{ action: "type", text: "x".repeat(400), delayMs: 10 }]);
    expect(long).toContain("xclip -selection clipboard -in >/dev/null 2>&1 && xdotool key --clearmodifiers ctrl+v");
    expect(long).toContain("else printf");
  });

  test("a failed batch names the action that failed and what did not run", () => {
    const batch: ComputerSequenceAction[] = [
      { action: "click", x: 1, y: 1, button: "left", double: false, triple: false, modifiers: [] },
      { action: "type", text: "a", delayMs: 0 },
      { action: "key", key: "Enter", modifiers: [], repeat: 1 },
    ];
    const message = describeSequenceFailure(batch, 1, 5, "USEAGENT_STEP_OK_1\nxdotool: command failed\n");
    expect(message).toBe("Action 3 of 5 (type) failed: xdotool: command failed. 2 actions before it ran; 2 after it did not. Take a screenshot before continuing.");
  });

  test("a screenshot region must be four bounds in screenshot pixels", async () => {
    setComputerUseServiceForTest(testService([]));
    const bad = await executeComputerUseTool(claims, "computer_screenshot", { region: [1, 2, 3] });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("region must be") });
  });
});

function testService(calls: string[]) {
  return {
    screenshot: async () => ({
      content: [
        { type: "image" as const, data: "cG5n", mimeType: "image/png" as const },
        { type: "text" as const, text: "Desktop screenshot captured at /root/work/screenshots/proof.png." },
      ],
      structuredContent: { path: "/root/work/screenshots/proof.png" },
    }),
    click: async (_claims: ToolTokenClaims, x: number, y: number, button: string, double: boolean) => {
      calls.push(`click:${x}:${y}:${button}:${double}`);
    },
    move: async (_claims: ToolTokenClaims, x: number, y: number) => {
      calls.push(`move:${x}:${y}`);
    },
    drag: async (_claims: ToolTokenClaims, startX: number, startY: number, endX: number, endY: number) => {
      calls.push(`drag:${startX}:${startY}:${endX}:${endY}`);
    },
    type: async (_claims: ToolTokenClaims, text: string, delayMs: number) => {
      calls.push(`type:${text}:${delayMs}`);
    },
    key: async (_claims: ToolTokenClaims, key: string, modifiers: string[]) => {
      calls.push(`key:${modifiers.join("+")}:${key}`);
    },
    hotkey: async (_claims: ToolTokenClaims, keys: string) => {
      calls.push(`hotkey:${keys}`);
    },
    scroll: async (_claims: ToolTokenClaims, x: number, y: number, direction: string, amount: number) => {
      calls.push(`scroll:${x}:${y}:${direction}:${amount}`);
    },
    sequence: async (
      _claims: ToolTokenClaims,
      actions: readonly { readonly action: string }[],
      captureScreenshot: boolean,
    ) => {
      calls.push(`sequence:${actions.map(({ action }) => action).join(",")}:${captureScreenshot}`);
      return captureScreenshot
        ? {
            content: [
              { type: "image" as const, data: "cG5n", mimeType: "image/png" as const },
              { type: "text" as const, text: "Desktop screenshot captured at /root/work/screenshots/proof.png." },
            ],
            structuredContent: { path: "/root/work/screenshots/proof.png" },
          }
        : null;
    },
  };
}

afterEach(() => {
  setComputerUseServiceForTest(null);
  setSandboxArtifactPublisherForTest(null);
});

const screenshotArtifact: ArtifactDescriptor = {
  id: "artifact-proof-1",
  run_id: "run-1",
  thread_id: "thread-1",
  name: "proof.png",
  source_path: "/root/work/screenshots/proof.png",
  content_type: "image/png",
  size_bytes: 1234,
  sha256: "abc123",
  created_at: "2026-08-21T00:00:00.000Z",
  preview_url: "/api/artifacts/artifact-proof-1/content",
  download_url: "/api/artifacts/artifact-proof-1/content?download=1",
  preview_pdf_url: null,
  workpiece: null,
};

function textAt(content: readonly ComputerToolContent[], index: number): string {
  const item = content[index];
  if (item?.type !== "text") throw new Error(`content[${index}] is not text`);
  return item.text;
}

async function desktopPng(): Promise<Buffer> {
  const width = 1920;
  const height = 1080;
  const pixels = Buffer.allocUnsafe(width * height * 3);
  let state = 0x12345678;
  for (let index = 0; index < pixels.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[index] = state & 0xff;
  }
  return await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe("computer-use gateway tools", () => {
  test.each([
    ["daytona", "/root/work"],
    ["cube", "/root/work"],
    ["box", "/home/user/work"],
  ] as const)("captures %s screenshots beneath its declared workspace", async (kind, root) => {
    const commands: string[] = [];
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    const sandbox = {
      id: `screenshot-${kind}`, providerKind: kind, cpu: 2, memory: 4,
      process: { executeCommand: async (command: string) => { commands.push(command); return { exitCode: 0, result: "" }; } },
      fs: { downloadFile: async () => png },
      ...(kind === "daytona" ? {
        computerUse: {
          screenshot: {
            takeFullScreen: async () => {
              throw new Error("native screenshot must not capture a different desktop");
            },
          },
        },
      } : {}),
    } as unknown as SandboxHandle;
    const response = await captureSandboxScreenshot(sandbox);
    const path = String(response.structuredContent?.path);
    expect(path.startsWith(`${root}/screenshots/screenshot-`)).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
    expect(commands.join("\n")).toContain(path);
    if (kind !== "box") expect(commands.join("\n")).toContain("export DISPLAY=:1");
    expect(response.isError).toBeUndefined();
  });

  test("keeps the full desktop PNG while returning a bounded model JPEG", async () => {
    const commands: string[] = [];
    let downloaded = "";
    const original = await desktopPng();
    const sandbox = {
      id: "box-native",
      providerKind: "box",
      cpu: 2,
      memory: 4,
      desktop: {
        display: ":0",
        home: "/home/user",
        workdir: "/home/user/work",
        browserExecutable: null,
        start: async () => {},
      },
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          return { exitCode: 0, result: "" };
        },
      },
      fs: {
        downloadFile: async (path: string) => {
          downloaded = path;
          return original;
        },
      },
    } as unknown as SandboxHandle;

    const response = await captureSandboxScreenshot(sandbox);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("export DISPLAY=:0");
    expect(commands[0]).not.toContain("base64 -w0");
    expect(downloaded).toMatch(
      /^\/home\/user\/work\/screenshots\/screenshot-\d+\.png$/,
    );
    // Instructions before the image, and the size the model sees stated with the display size.
    const note = response.content[0];
    expect(note?.type).toBe("text");
    if (note?.type === "text") expect(note.text).toMatch(/^Screenshot \d+x\d+ of a \d+x\d+ display\. Give coordinates in screenshot pixels/);
    const image = response.content[1];
    expect(image?.type).toBe("image");
    if (image?.type !== "image") throw new Error("expected a model screenshot");
    const modelBytes = Buffer.from(image.data, "base64");
    expect(image.mimeType).toBe("image/jpeg");
    expect(modelBytes.byteLength).toBeLessThanOrEqual(MODEL_SCREENSHOT_MAX_BYTES);
    expect(modelBytes.byteLength).toBeLessThan(original.byteLength);
    expect(image.data.length * 6).toBeLessThan(8 * 1024 * 1024);
    expect(response.structuredContent?.path).toBe(downloaded);
  });

  test("gives every harness the exact secure handoff for requested screenshot proof", () => {
    const path = "/root/work/screenshots/proof.png";
    const message = screenshotArtifactHandoff(path);

    expect(message).toContain(`path=${path}`);
    expect(message).toContain("purpose=user_requested_proof");
    expect(message).toContain("private model inspection by default");
  });

  test("maps provider-neutral key names to X11 keysyms", () => {
    expect(x11KeyName("ENTER")).toBe("Return");
    expect(x11KeyName("ArrowUp")).toBe("Up");
    expect(x11KeyName("Backspace")).toBe("BackSpace");
    expect(x11KeyName("l")).toBe("l");
    expect(x11KeyCommand("ENTER")).toBe(
      "xdotool keydown --clearmodifiers Return; sleep 0.1; xdotool keyup Return; sleep 0.2",
    );
    expect(x11KeyCommand("l", ["ctrl", "shift"])).toBe(
      "xdotool keyup ctrl alt shift Super_L && sleep 0.05 && xdotool keydown ctrl && " +
        "xdotool keydown shift && xdotool key l; status=$?; xdotool keyup shift; " +
        "xdotool keyup ctrl; sleep 0.2; test $status -eq 0",
    );
    expect(x11HotkeyCommand("ctrl+alt+t")).toBe(
      "xdotool keyup ctrl alt shift Super_L && sleep 0.05 && xdotool keydown ctrl && " +
        "xdotool keydown alt && xdotool key t; status=$?; xdotool keyup alt; " +
        "xdotool keyup ctrl; sleep 0.2; test $status -eq 0",
    );
  });

  test("advertises the bounded sequence path while retaining legacy atomic execution compatibility", () => {
    expect(COMPUTER_USE_TOOLS.map((tool) => tool.name)).toEqual([
      "computer_screenshot",
      "computer_sequence",
    ]);
    expect(COMPUTER_USE_TOOL_NAMES).toEqual(new Set([
      "computer_screenshot",
      "computer_sequence",
      "computer_click",
      "computer_move",
      "computer_drag",
      "computer_type",
      "computer_key",
      "computer_hotkey",
      "computer_scroll",
    ]));
    expect(COMPUTER_USE_TOOLS.map((tool) => tool.name).join(" ")).not.toContain("browser_");
  });

  test("returns a model-visible screenshot without implicitly publishing it", async () => {
    setComputerUseServiceForTest(testService([]));
    const response = await executeComputerUseTool(claims, "computer_screenshot", {});

    expect(response.isError).toBeUndefined();
    expect(response.content).toEqual([
      { type: "image", data: "cG5n", mimeType: "image/png" },
      { type: "text", text: "Desktop screenshot captured at /root/work/screenshots/proof.png." },
    ]);
    expect(response.structuredContent).toEqual({ path: "/root/work/screenshots/proof.png" });
  });

  test("validates and dispatches mouse and keyboard actions", async () => {
    const calls: string[] = [];
    setComputerUseServiceForTest(testService(calls));

    await executeComputerUseTool(claims, "computer_click", { x: 12, y: 34, button: "right", double: true });
    await executeComputerUseTool(claims, "computer_type", { text: "hello", delay_ms: 5 });
    await executeComputerUseTool(claims, "computer_key", { key: "l", modifiers: ["ctrl", "shift"] });
    await executeComputerUseTool(claims, "computer_scroll", { x: 40, y: 50, direction: "down", amount: 4 });

    expect(calls).toEqual([
      "click:12:34:right:true",
      "type:hello:5",
      "key:ctrl+shift:l",
      "scroll:40:50:down:4",
    ]);
  });

  test("dispatches a bounded action sequence and can return one private screenshot", async () => {
    const calls: string[] = [];
    setComputerUseServiceForTest(testService(calls));

    const response = await executeComputerUseTool(claims, "computer_sequence", {
      actions: [
        { action: "click", x: 12, y: 34 },
        { action: "type", text: "hello", delay_ms: 1 },
        { action: "key", key: "Enter" },
        { action: "wait", ms: 0 },
      ],
      screenshot: true,
    });

    expect(response.isError).toBeUndefined();
    expect(calls).toEqual(["sequence:click,type,key,wait:true"]);
    expect(response.content[0]).toEqual({
      type: "text",
      text: "Computer sequence completed. Executed actions: click, type, key, wait. " +
        "Desktop screenshot captured at /root/work/screenshots/proof.png.",
    });
    expect(response.content[1]).toEqual({ type: "image", data: "cG5n", mimeType: "image/png" });
    expect(response.structuredContent).toEqual({
      path: "/root/work/screenshots/proof.png",
      action: "computer_sequence",
      action_count: 4,
      executed_actions: ["click", "type", "key", "wait"],
    });
  });

  test("can atomically publish an explicitly requested proof screenshot from computer_sequence", async () => {
    const calls: string[] = [];
    const publishInputs: unknown[] = [];
    setComputerUseServiceForTest(testService(calls));
    setSandboxArtifactPublisherForTest(async (input) => {
      publishInputs.push(input);
      return { artifact: screenshotArtifact, created: true };
    });

    const response = await executeComputerUseTool(claims, "computer_sequence", {
      actions: [{ action: "wait", ms: 0 }],
      screenshot: true,
      publish_screenshot: true,
      purpose: "user_requested_proof",
    });

    expect(response.isError).toBeUndefined();
    expect(calls).toEqual(["sequence:wait:true"]);
    expect(publishInputs).toEqual([{
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
      threadId: "thread-1",
      path: "/root/work/screenshots/proof.png",
      purpose: "user_requested_proof",
    }]);
    expect(textAt(response.content, 0)).toContain("Computer sequence completed. Executed actions: wait.");
    expect(textAt(response.content, 0)).toContain("Published proof.png (1234 bytes) as artifact artifact-proof-1.");
    expect(response.content[1]).toEqual({ type: "image", data: "cG5n", mimeType: "image/png" });
    expect(response.structuredContent).toMatchObject({
      path: "/root/work/screenshots/proof.png",
      action: "computer_sequence",
      artifact: {
        id: "artifact-proof-1",
        preview_url: "/api/artifacts/artifact-proof-1/content",
      },
      proof_published: true,
    });
  });

  test("fails closed when proof publication is requested without an explicit proof screenshot", async () => {
    const calls: string[] = [];
    const publishInputs: unknown[] = [];
    setComputerUseServiceForTest(testService(calls));
    setSandboxArtifactPublisherForTest(async (input) => {
      publishInputs.push(input);
      return { artifact: screenshotArtifact, created: true };
    });

    const missingScreenshot = await executeComputerUseTool(claims, "computer_sequence", {
      actions: [{ action: "wait", ms: 0 }],
      publish_screenshot: true,
      purpose: "user_requested_proof",
    });
    const wrongPurpose = await executeComputerUseTool(claims, "computer_sequence", {
      actions: [{ action: "wait", ms: 0 }],
      screenshot: true,
      publish_screenshot: true,
      purpose: "deliverable",
    });

    expect(missingScreenshot).toMatchObject({ isError: true });
    expect(textAt(missingScreenshot.content, 0)).toBe("publish_screenshot requires screenshot=true");
    expect(wrongPurpose).toMatchObject({ isError: true });
    expect(textAt(wrongPurpose.content, 0)).toBe("publish_screenshot requires purpose=user_requested_proof");
    expect(calls).toEqual([]);
    expect(publishInputs).toEqual([]);
  });

  test("rejects invalid action sequences before touching the sandbox", async () => {
    const calls: string[] = [];
    setComputerUseServiceForTest(testService(calls));

    const tooMany = await executeComputerUseTool(claims, "computer_sequence", {
      actions: Array.from({ length: 9 }, () => ({ action: "wait", ms: 0 })),
    });
    const unsafeText = await executeComputerUseTool(claims, "computer_sequence", {
      actions: [{ action: "type", text: "x".repeat(2_001) }],
    });

    expect(tooMany).toMatchObject({ isError: true });
    expect(tooMany.content[0]).toEqual({
      type: "text",
      text: "actions must contain 1 to 8 items",
    });
    expect(unsafeText).toMatchObject({ isError: true });
    expect(unsafeText.content[0]).toEqual({
      type: "text",
      text: "actions[0].text must be a non-empty string no longer than 2000 characters",
    });
    expect(calls).toEqual([]);
  });

  test("rejects invalid buttons and modifiers before touching the sandbox", async () => {
    const calls: string[] = [];
    setComputerUseServiceForTest(testService(calls));

    const badButton = await executeComputerUseTool(claims, "computer_click", {
      x: 1,
      y: 2,
      button: "forward",
    });
    const badModifier = await executeComputerUseTool(claims, "computer_key", {
      key: "l",
      modifiers: ["meta; touch /tmp/pwned"],
    });

    expect(badButton).toMatchObject({ isError: true });
    expect(badButton.content[0]).toEqual({
      type: "text",
      text: "button must be left, middle, or right",
    });
    expect(badModifier).toMatchObject({ isError: true });
    expect(badModifier.content[0]).toEqual({
      type: "text",
      text: "modifiers must contain only ctrl, alt, shift, or cmd",
    });
    expect(calls).toEqual([]);
  });
});

describe("navigate without a browser relay", () => {
  test("a provider-native desktop opens the URL through the address bar or a fresh browser", () => {
    const command = addressBarNavigateCommand("https://x.com/a'b?q=1", "/usr/bin/google-chrome");
    expect(command).toContain("xdotool search --onlyvisible --class chrom");
    expect(command).toContain("xdotool key --clearmodifiers ctrl+l");
    expect(command).toContain("xdotool type --clearmodifiers");
    expect(command).toContain("xdotool key --clearmodifiers Return");
    expect(command).toContain("(setsid '/usr/bin/google-chrome' 'https://x.com/a%27b?q=1' >/dev/null 2>&1 &)");
    expect(command).not.toContain("a'b");
    expect(addressBarNavigateCommand("https://x.com/", null)).toContain("command -v google-chrome");
  });
});

describe("computer_sequence navigate", () => {
  test("a URL is opened over the browser control transport, never typed", () => {
    const batches = sequenceBatches([
      { action: "click", x: 10, y: 10, button: "left", double: false, triple: false, modifiers: [] },
      { action: "navigate", url: "https://x.com/bhowconda" },
      { action: "wait", ms: 250 },
      { action: "key", key: "Return", modifiers: [], repeat: 1 },
    ]);
    expect(batches).toEqual([
      { shell: [{ action: "click", x: 10, y: 10, button: "left", double: false, triple: false, modifiers: [] }] },
      { navigate: "https://x.com/bhowconda" },
      { shell: [{ action: "wait", ms: 250 }, { action: "key", key: "Return", modifiers: [], repeat: 1 }] },
    ]);
  });
});
