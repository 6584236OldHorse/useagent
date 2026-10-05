import { navigateVisibleBrowserPage } from "../../engines/browser-mcp";
import {
  addressBarNavigateCommand,
  buildCubeSequenceCommand,
  buttonNumber,
  type ComputerSequenceAction,
  type Button,
  type Direction,
  DEFAULT_DISPLAY,
  DEFAULT_SCREENSHOT_WIDTH,
  describeSequenceFailure,
  sequenceBatches,
  x11HotkeyCommand,
  x11KeyCommand,
  x11KeyName,
} from "./computer-use-shell";
export {
  buildCubeSequenceCommand,
  coordinatePrefix,
  type ComputerSequenceAction,
  describeSequenceFailure,
  sequenceBatches,
  x11HotkeyCommand,
  x11KeyCommand,
  x11KeyName,
} from "./computer-use-shell";

import { ensureSandboxDesktopView } from "../../engines/desktop";
import { getRunForOrg } from "../../runs/repo";
import { type SandboxHandle, sandboxProviderKind, sandboxRuntimeLayout } from "../../sandboxes/provider";
import { executeArtifactTool, type ToolResult } from "./artifact-tools";
import { compressScreenshotForModelSized } from "./screenshot-compression";
import type { ToolTokenClaims } from "./token";
import { resolveRunSandbox } from "../../sandboxes/binding";

export type ComputerToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" };

interface ComputerToolResult {
  content: ComputerToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface ComputerUseService {
  screenshot(claims: ToolTokenClaims, region?: ScreenshotRegion): Promise<ComputerToolResult>;
  sequence(
    claims: ToolTokenClaims,
    actions: readonly ComputerSequenceAction[],
    captureScreenshot: boolean,
  ): Promise<ComputerToolResult | null>;
  click(claims: ToolTokenClaims, x: number, y: number, button: Button, double: boolean): Promise<void>;
  move(claims: ToolTokenClaims, x: number, y: number): Promise<void>;
  drag(claims: ToolTokenClaims, startX: number, startY: number, endX: number, endY: number): Promise<void>;
  type(claims: ToolTokenClaims, text: string, delayMs: number): Promise<void>;
  key(claims: ToolTokenClaims, key: string, modifiers: string[]): Promise<void>;
  hotkey(claims: ToolTokenClaims, keys: string): Promise<void>;
  scroll(claims: ToolTokenClaims, x: number, y: number, direction: Direction, amount: number): Promise<void>;
}

const MAX_COORDINATE = 10_000;
const MAX_TEXT_LENGTH = 20_000;
const KEY_RE = /^[A-Za-z0-9_+ -]{1,80}$/;
const BUTTONS = new Set<Button>(["left", "middle", "right"]);
const MODIFIERS = new Set(["ctrl", "alt", "shift", "cmd"]);
const MAX_SEQUENCE_ACTIONS = 8;
const MAX_SEQUENCE_TEXT_LENGTH = 2_000;
const MAX_SEQUENCE_WAIT_MS = 30_000;
const MAX_HOLD_MS = 30_000;
const screenshotWidths = new Map<string, number>();
const displaySizes = new Map<string, { readonly width: number; readonly height: number }>();
const USER_REQUESTED_PROOF_PURPOSE = "user_requested_proof";

/** A zoom region in screenshot pixels: left, top, right, bottom. */
export type ScreenshotRegion = readonly [number, number, number, number];

function screenshotRegion(value: unknown): ScreenshotRegion | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 4) throw new Error("region must be [left, top, right, bottom] in screenshot pixels");
  const [left, top, right, bottom] = value.map((part, index) => integer(part, `region[${index}]`, 0, 10_000));
  if (right! - left! < 8 || bottom! - top! < 8) throw new Error("region must be at least 8 by 8 screenshot pixels");
  return [left!, top!, right!, bottom!];
}

function result(text: string, structuredContent?: Record<string, unknown>): ComputerToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function sequenceActionNames(actions: readonly ComputerSequenceAction[]): string[] {
  return actions.map(({ action }) => action);
}

function sequenceReceipt(actionNames: readonly string[]): string {
  return `Computer sequence completed. Executed actions: ${actionNames.join(", ")}.`;
}

export function screenshotArtifactHandoff(path: string): string {
  return `Desktop screenshot captured at ${path}. This screenshot is private model inspection by default. ` +
    "If the user explicitly requested durable proof, call artifact_publish before responding with " +
    `path=${path} and purpose=user_requested_proof.`;
}

function withSequenceReceipt(
  captured: ComputerToolResult,
  actions: readonly ComputerSequenceAction[],
): ComputerToolResult {
  const actionNames = sequenceActionNames(actions);
  const receipt = sequenceReceipt(actionNames);
  const textIndex = captured.content.findIndex(({ type }) => type === "text");
  const existingText = textIndex >= 0 && captured.content[textIndex]!.type === "text"
    ? captured.content[textIndex]!.text
    : "";
  const content: ComputerToolContent[] = [
    {
      type: "text",
      text: `${receipt} ${existingText}`.trim(),
    },
    ...captured.content.filter((_, index) => index !== textIndex),
  ];
  return {
    ...captured,
    content,
    structuredContent: {
      ...(captured.structuredContent ?? {}),
      action: "computer_sequence",
      action_count: actions.length,
      executed_actions: actionNames,
    },
  };
}

function withPublishedProof(
  captured: ComputerToolResult,
  actions: readonly ComputerSequenceAction[],
  published: ToolResult,
): ComputerToolResult {
  const sequenced = withSequenceReceipt(captured, actions);
  const proofText = published.content.map(({ text }) => text).join("\n");
  const textIndex = sequenced.content.findIndex(({ type }) => type === "text");
  const existingText = textIndex >= 0 && sequenced.content[textIndex]!.type === "text"
    ? sequenced.content[textIndex]!.text
    : "";
  const content: ComputerToolContent[] = [
    {
      type: "text",
      text: `${existingText}\n${proofText}`.trim(),
    },
    ...sequenced.content.filter((_, index) => index !== textIndex),
  ];
  return {
    content,
    structuredContent: {
      ...(sequenced.structuredContent ?? {}),
      ...(published.structuredContent ?? {}),
      proof_published: published.isError !== true,
    },
    ...(published.isError ? { isError: true } : {}),
  };
}

function failure(text: string): ComputerToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function integer(value: unknown, name: string, min = 0, max = MAX_COORDINATE): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

function string(value: unknown, name: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty string no longer than ${maxLength} characters`);
  }
  return value;
}

function keyName(value: unknown, name = "key"): string {
  const key = string(value, name, 80);
  if (!KEY_RE.test(key)) throw new Error(`${name} contains unsupported characters`);
  return key;
}


function buttonName(value: unknown): Button {
  const button = value ?? "left";
  if (typeof button !== "string" || !BUTTONS.has(button as Button)) {
    throw new Error("button must be left, middle, or right");
  }
  return button as Button;
}

function scrollDirection(value: unknown, name: string): Direction {
  if (value !== "up" && value !== "down" && value !== "left" && value !== "right") {
    throw new Error(`${name} must be up, down, left, or right`);
  }
  return value;
}

function modifiers(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((modifier) => typeof modifier !== "string" || !MODIFIERS.has(modifier))) {
    throw new Error("modifiers must contain only ctrl, alt, shift, or cmd");
  }
  return value;
}

function httpUrl(value: unknown, name: string): string {
  const text = string(value, name, 2048);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${name} must be an absolute http or https URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${name} must be an absolute http or https URL`);
  return parsed.toString();
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseSequenceAction(value: unknown, index: number): ComputerSequenceAction {
  const action = record(value, `actions[${index}]`);
  const kind = action.action;
  if (typeof kind !== "string") throw new Error(`actions[${index}].action must be a string`);
  switch (kind) {
    case "click":
      return {
        action: "click",
        x: integer(action.x, `actions[${index}].x`),
        y: integer(action.y, `actions[${index}].y`),
        button: buttonName(action.button),
        double: action.double === true,
        triple: action.triple === true,
        modifiers: modifiers(action.modifiers),
      };
    case "move":
      return {
        action: "move",
        x: integer(action.x, `actions[${index}].x`),
        y: integer(action.y, `actions[${index}].y`),
      };
    case "drag":
      return {
        action: "drag",
        startX: integer(action.start_x, `actions[${index}].start_x`),
        startY: integer(action.start_y, `actions[${index}].start_y`),
        endX: integer(action.end_x, `actions[${index}].end_x`),
        endY: integer(action.end_y, `actions[${index}].end_y`),
      };
    case "type":
      return {
        action: "type",
        text: string(action.text, `actions[${index}].text`, MAX_SEQUENCE_TEXT_LENGTH),
        delayMs: integer(action.delay_ms ?? 10, `actions[${index}].delay_ms`, 0, 1000),
      };
    case "key":
      return {
        action: "key",
        key: keyName(action.key, `actions[${index}].key`),
        modifiers: modifiers(action.modifiers),
        repeat: integer(action.repeat ?? 1, `actions[${index}].repeat`, 1, 100),
      };
    case "hold_key":
      return {
        action: "hold_key",
        key: keyName(action.key, `actions[${index}].key`),
        durationMs: integer(action.duration_ms ?? 1000, `actions[${index}].duration_ms`, 1, MAX_HOLD_MS),
      };
    case "hotkey":
      return {
        action: "hotkey",
        keys: keyName(action.keys, `actions[${index}].keys`),
      };
    case "navigate":
      return { action: "navigate", url: httpUrl(action.url, `actions[${index}].url`) };
    case "scroll": {
      return {
        action: "scroll",
        x: integer(action.x, `actions[${index}].x`),
        y: integer(action.y, `actions[${index}].y`),
        direction: scrollDirection(action.direction, `actions[${index}].direction`),
        amount: integer(action.amount ?? 3, `actions[${index}].amount`, 1, 100),
      };
    }
    case "wait":
      return {
        action: "wait",
        ms: integer(action.ms ?? 250, `actions[${index}].ms`, 0, MAX_SEQUENCE_WAIT_MS),
      };
    default:
      throw new Error(`actions[${index}].action must be one of click, move, drag, type, key, hold_key, hotkey, navigate, scroll, wait`);
  }
}

function sequenceActions(value: unknown): ComputerSequenceAction[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SEQUENCE_ACTIONS) {
    throw new Error(`actions must contain 1 to ${MAX_SEQUENCE_ACTIONS} items`);
  }
  return value.map(parseSequenceAction);
}

function sequenceRequestedProof(args: Record<string, unknown>): boolean {
  if (args.publish_screenshot !== true) return false;
  if (args.screenshot !== true) throw new Error("publish_screenshot requires screenshot=true");
  if (args.purpose !== USER_REQUESTED_PROOF_PURPOSE) {
    throw new Error("publish_screenshot requires purpose=user_requested_proof");
  }
  return true;
}

function capturedScreenshotPath(captured: ComputerToolResult): string {
  const path = captured.structuredContent?.path;
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("publish_screenshot requires a captured screenshot path");
  }
  return path.trim();
}

async function computerSandbox(claims: ToolTokenClaims): Promise<SandboxHandle> {
  const run = await getRunForOrg(claims.orgId, claims.runId);
  if (!run || run.threadId !== claims.threadId) throw new Error("run is not active in this thread");
  if (!run.sandboxId) throw new Error("no sandbox is attached to this run");
  return await resolveRunSandbox(run);
}

/** Desktop readiness per sandbox: a turn's tool calls probe the desktop once, not every call
 *  (the probe and the relay file check cost seconds each over the provider API). A failed
 *  command clears the entry so the next call probes again. */
const desktopReadyUntil = new Map<string, number>();
const DESKTOP_READY_TTL_MS = 60_000;

async function readySandbox(claims: ToolTokenClaims): Promise<SandboxHandle> {
  const sandbox = await computerSandbox(claims);
  if ((desktopReadyUntil.get(sandbox.id) ?? 0) > Date.now()) return sandbox;
  const desktop = await ensureSandboxDesktopView(sandbox, AbortSignal.timeout(60_000));
  if (!desktop.available) throw new Error(desktop.reason ?? "desktop failed readiness");
  desktopReadyUntil.set(sandbox.id, Date.now() + DESKTOP_READY_TTL_MS);
  return sandbox;
}

async function cubeCommand(sandbox: SandboxHandle, command: string): Promise<string> {
  const display = sandbox.desktop?.display ?? DEFAULT_DISPLAY;
  const executed = await sandbox.process.executeCommand(
    `export DISPLAY=${display}; ${command}`,
    undefined,
    undefined,
    60,
  );
  if ((executed.exitCode ?? 1) !== 0) {
    desktopReadyUntil.delete(sandbox.id);
    throw new Error(
      (executed.result ?? "computer-use command failed; the desktop may still be starting - retry once").trim(),
    );
  }
  return executed.result ?? "";
}


export async function captureSandboxScreenshot(
  sandbox: SandboxHandle,
  region?: ScreenshotRegion,
): Promise<ComputerToolResult> {
  const workspaceRoot = sandboxRuntimeLayout(sandbox.providerKind ?? sandboxProviderKind()).workdir;
  const path = `${workspaceRoot}/screenshots/screenshot-${Date.now()}.png`;
  const display = sandbox.desktop?.display ?? DEFAULT_DISPLAY;
  const output = await cubeCommand(
    sandbox,
    `mkdir -p "$(dirname '${path}')"; ` +
      `size=$(xdpyinfo -display ${display} | awk '/dimensions:/{print $2; exit}'); ` +
      `ffmpeg -hide_banner -loglevel error -f x11grab -video_size "$size" -i ${display} ` +
      `-frames:v 1 -y '${path}' && echo "SIZE=$size"`,
  );
  const size = /SIZE=(\d+)x(\d+)/.exec(output);
  const displaySize = size
    ? { width: Number(size[1]), height: Number(size[2]) }
    : displaySizes.get(sandbox.id) ?? { width: 1920, height: 1080 };
  displaySizes.set(sandbox.id, displaySize);
  const file = await sandbox.fs.downloadFile(path);
  if (region) {
    // Zoom: a crop of the full-resolution capture, so small text becomes readable.
    // Coordinates stay in full-screenshot pixels; the crop does not change the space.
    const scale = displaySize.width / screenshotWidthFor(sandbox);
    const crop = {
      left: Math.max(0, Math.round(region[0] * scale)),
      top: Math.max(0, Math.round(region[1] * scale)),
      width: Math.max(1, Math.round((region[2] - region[0]) * scale)),
      height: Math.max(1, Math.round((region[3] - region[1]) * scale)),
    };
    const zoomed = await compressScreenshotForModelSized(file, { crop, allowEnlargement: true });
    return {
      content: [
        {
          type: "text",
          text: `Zoomed view of screenshot region [${region.join(", ")}] at ${zoomed.width}x${zoomed.height}. ` +
            `Coordinates for actions stay in full-screenshot pixels (${screenshotWidthFor(sandbox)} wide). ${screenshotArtifactHandoff(path)}`,
        },
        { type: "image", data: zoomed.buffer.toString("base64"), mimeType: "image/jpeg" },
      ],
      structuredContent: { path, region: [...region] },
    };
  }
  const shot = await compressScreenshotForModelSized(file);
  screenshotWidths.set(sandbox.id, shot.width);
  return {
    content: [
      {
        type: "text",
        text: `Screenshot ${shot.width}x${shot.height} of a ${displaySize.width}x${displaySize.height} display. ` +
          `Give coordinates in screenshot pixels; they are scaled to the display. ${screenshotArtifactHandoff(path)}`,
      },
      { type: "image", data: shot.buffer.toString("base64"), mimeType: "image/jpeg" },
    ],
    structuredContent: { path, screenshot: { width: shot.width, height: shot.height }, display: displaySize },
  };
}

function screenshotWidthFor(sandbox: SandboxHandle): number {
  return screenshotWidths.get(sandbox.id) ?? DEFAULT_SCREENSHOT_WIDTH;
}

async function screenshot(claims: ToolTokenClaims, region?: ScreenshotRegion): Promise<ComputerToolResult> {
  return await captureSandboxScreenshot(await readySandbox(claims), region);
}

const productionService: ComputerUseService = {
  screenshot,
  async sequence(claims, actions, captureScreenshot) {
    const sandbox = await readySandbox(claims);
    const options = { display: sandbox.desktop?.display ?? DEFAULT_DISPLAY, screenshotWidth: screenshotWidthFor(sandbox) };
    let offset = 0;
    for (const batch of sequenceBatches(actions)) {
      if ("navigate" in batch) {
        try {
          // A provider-native desktop has no browser relay: the URL goes through the address bar.
          if (sandbox.desktop) await cubeCommand(sandbox, addressBarNavigateCommand(batch.navigate, sandbox.desktop.browserExecutable ?? null));
          else await navigateVisibleBrowserPage(sandbox, batch.navigate);
        } catch (error) {
          desktopReadyUntil.delete(sandbox.id);
          throw new Error(`Action ${offset + 1} of ${actions.length} (navigate) failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        offset += 1;
        continue;
      }
      try {
        await cubeCommand(sandbox, buildCubeSequenceCommand(batch.shell, options));
      } catch (error) {
        throw new Error(describeSequenceFailure(batch.shell, offset, actions.length, error instanceof Error ? error.message : String(error)));
      }
      offset += batch.shell.length;
    }
    return captureScreenshot ? await captureSandboxScreenshot(sandbox) : null;
  },
  async click(claims, x, y, button, double) {
    const sandbox = await readySandbox(claims);
    await cubeCommand(sandbox, buildCubeSequenceCommand([{ action: "click", x, y, button, double, triple: false, modifiers: [] }], atomicOptions(sandbox)));
  },
  async move(claims, x, y) {
    const sandbox = await readySandbox(claims);
    await cubeCommand(sandbox, buildCubeSequenceCommand([{ action: "move", x, y }], atomicOptions(sandbox)));
  },
  async drag(claims, startX, startY, endX, endY) {
    const sandbox = await readySandbox(claims);
    await cubeCommand(sandbox, buildCubeSequenceCommand([{ action: "drag", startX, startY, endX, endY }], atomicOptions(sandbox)));
  },
  async type(claims, text, delayMs) {
    const sandbox = await readySandbox(claims);
    const encoded = Buffer.from(text, "utf8").toString("base64");
    await cubeCommand(sandbox, `printf '%s' '${encoded}' | base64 -d | xdotool type --clearmodifiers --delay ${delayMs} --file -`);
  },
  async key(claims, key, modifiers) {
    const sandbox = await readySandbox(claims);
    await cubeCommand(
      sandbox,
      x11KeyCommand(key, modifiers),
    );
  },
  async hotkey(claims, keys) {
    const sandbox = await readySandbox(claims);
    await cubeCommand(sandbox, x11HotkeyCommand(keys));
  },
  async scroll(claims, x, y, direction, amount) {
    const sandbox = await readySandbox(claims);
    await cubeCommand(sandbox, buildCubeSequenceCommand([{ action: "scroll", x, y, direction, amount }], atomicOptions(sandbox)));
  },
};

function atomicOptions(sandbox: SandboxHandle) {
  return { display: sandbox.desktop?.display ?? DEFAULT_DISPLAY, screenshotWidth: screenshotWidthFor(sandbox) };
}

let serviceOverride: ComputerUseService | null = null;

export function setComputerUseServiceForTest(service: ComputerUseService | null): void {
  serviceOverride = service;
}

export const COMPUTER_USE_TOOLS = [
  {
    name: "computer_screenshot",
    description:
      "Capture the desktop for private model inspection. The image is scaled to 1280 pixels wide; give every coordinate in screenshot pixels and they are scaled to the display. Pass region=[left, top, right, bottom] to zoom into an area at full resolution when text is too small to read. Use it for the initial state and after an uncertain or failed transition.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "array",
          items: { type: "integer", minimum: 0 },
          minItems: 4,
          maxItems: 4,
          description: "Optional zoom: [left, top, right, bottom] in screenshot pixels; returns that area at full resolution for reading small text. Coordinates for actions stay in full-screenshot pixels.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "computer_sequence",
    description:
      "Primary desktop action tool. Run 1-8 OS-level actions in one ordered batch; by default the batch ends with one private screenshot. Batch every predictable action chain, including click+type+submit, instead of issuing atomic calls, and stop the batch at the first point that needs new visual inspection. Coordinates are screenshot pixels. Actions: click (button, double, triple, modifiers such as shift for range selection), move, drag, type (long text is pasted, not typed), key (with modifiers and repeat), hold_key, hotkey, navigate, scroll (up, down, left, right), wait (up to 30 s). To open a URL use navigate; never type a URL into the address bar. A failure names the action that failed and what did not run.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SEQUENCE_ACTIONS,
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["click", "move", "drag", "type", "key", "hold_key", "hotkey", "navigate", "scroll", "wait"],
              },
              x: { type: "integer" },
              y: { type: "integer" },
              start_x: { type: "integer" },
              start_y: { type: "integer" },
              end_x: { type: "integer" },
              end_y: { type: "integer" },
              url: { type: "string", description: "navigate only: absolute http or https URL to open in the visible browser page" },
              button: { type: "string", enum: ["left", "middle", "right"] },
              double: { type: "boolean" },
              triple: { type: "boolean", description: "click only: triple click, selects a line or paragraph" },
              repeat: { type: "integer", minimum: 1, maximum: 100, description: "key only: press this many times" },
              duration_ms: { type: "integer", minimum: 1, maximum: MAX_HOLD_MS, description: "hold_key only" },
              text: { type: "string" },
              delay_ms: { type: "integer", minimum: 0, maximum: 1000 },
              key: { type: "string" },
              keys: { type: "string" },
              modifiers: {
                type: "array",
                items: { type: "string", enum: ["ctrl", "alt", "shift", "cmd"] },
              },
              direction: { type: "string", enum: ["up", "down", "left", "right"] },
              amount: { type: "integer", minimum: 1, maximum: 100 },
              ms: { type: "integer", minimum: 0, maximum: MAX_SEQUENCE_WAIT_MS },
            },
            required: ["action"],
            additionalProperties: false,
          },
        },
        screenshot: { type: "boolean", description: "Default true: end the batch with a private screenshot. Set false only when the next action does not depend on the result." },
        publish_screenshot: {
          type: "boolean",
          description:
            "Only set true when the user explicitly requested durable desktop proof. Requires screenshot=true and purpose=user_requested_proof; publishes only the post-sequence screenshot.",
        },
        purpose: {
          type: "string",
          enum: [USER_REQUESTED_PROOF_PURPOSE],
          description: "Required as user_requested_proof when publish_screenshot=true.",
        },
      },
      required: ["actions"],
      additionalProperties: false,
    },
  },
] as const;

const LEGACY_ATOMIC_COMPUTER_TOOL_NAMES = [
  "computer_click",
  "computer_move",
  "computer_drag",
  "computer_type",
  "computer_key",
  "computer_hotkey",
  "computer_scroll",
] as const;

export const COMPUTER_USE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...COMPUTER_USE_TOOLS.map((tool) => tool.name),
  ...LEGACY_ATOMIC_COMPUTER_TOOL_NAMES,
]);

export async function executeComputerUseTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ComputerToolResult> {
  const service = serviceOverride ?? productionService;
  try {
    if (name === "computer_screenshot") return await service.screenshot(claims, screenshotRegion(args.region));
    if (name === "computer_sequence") {
      const actions = sequenceActions(args.actions);
      const publishProof = sequenceRequestedProof(args);
      const captured = await service.sequence(claims, actions, args.screenshot !== false);
      if (publishProof) {
        if (!captured) throw new Error("publish_screenshot requires a captured screenshot path");
        const published = await executeArtifactTool(claims, "artifact_publish", {
          path: capturedScreenshotPath(captured),
          purpose: USER_REQUESTED_PROOF_PURPOSE,
        });
        return withPublishedProof(captured, actions, published);
      }
      if (captured) return withSequenceReceipt(captured, actions);
      const actionNames = sequenceActionNames(actions);
      return result(sequenceReceipt(actionNames), {
        action: name,
        action_count: actions.length,
        executed_actions: actionNames,
      });
    }
    switch (name) {
      case "computer_click":
        await service.click(claims, integer(args.x, "x"), integer(args.y, "y"), buttonName(args.button), args.double === true);
        break;
      case "computer_move":
        await service.move(claims, integer(args.x, "x"), integer(args.y, "y"));
        break;
      case "computer_drag":
        await service.drag(claims, integer(args.start_x, "start_x"), integer(args.start_y, "start_y"), integer(args.end_x, "end_x"), integer(args.end_y, "end_y"));
        break;
      case "computer_type":
        await service.type(claims, string(args.text, "text"), integer(args.delay_ms ?? 10, "delay_ms", 0, 1000));
        break;
      case "computer_key":
        await service.key(claims, keyName(args.key), modifiers(args.modifiers));
        break;
      case "computer_hotkey":
        await service.hotkey(claims, keyName(args.keys, "keys"));
        break;
      case "computer_scroll":
        await service.scroll(
          claims,
          integer(args.x, "x"),
          integer(args.y, "y"),
          scrollDirection(args.direction, "direction"),
          integer(args.amount ?? 3, "amount", 1, 100),
        );
        break;
      default:
        return failure(`Unknown tool: ${name}`);
    }
    return result(`${name} completed`, { action: name });
  } catch (error) {
    return failure(error instanceof Error ? error.message : `${name} failed`);
  }
}
