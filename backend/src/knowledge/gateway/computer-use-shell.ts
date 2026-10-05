// The desktop tool's shell: xdotool commands for one action batch on the sandbox's X display.
// Coordinates arrive in screenshot pixels and are scaled to the display when the batch runs.

export type Button = "left" | "middle" | "right";
export type Direction = "up" | "down" | "left" | "right";
export type ComputerSequenceAction =
  | { readonly action: "click"; readonly x: number; readonly y: number; readonly button: Button; readonly double: boolean; readonly triple: boolean; readonly modifiers: readonly string[] }
  | { readonly action: "move"; readonly x: number; readonly y: number }
  | { readonly action: "drag"; readonly startX: number; readonly startY: number; readonly endX: number; readonly endY: number }
  | { readonly action: "type"; readonly text: string; readonly delayMs: number }
  | { readonly action: "key"; readonly key: string; readonly modifiers: readonly string[]; readonly repeat: number }
  | { readonly action: "hold_key"; readonly key: string; readonly durationMs: number }
  | { readonly action: "hotkey"; readonly keys: string }
  | { readonly action: "navigate"; readonly url: string }
  | { readonly action: "scroll"; readonly x: number; readonly y: number; readonly direction: Direction; readonly amount: number }
  | { readonly action: "wait"; readonly ms: number };

export const DEFAULT_DISPLAY = ":1";
/** Above this length text goes through the clipboard: keystrokes are slow and toolkits drop them. */
export const CLIPBOARD_TEXT_THRESHOLD = 200;
/** The model sees screenshots at this width; its coordinates are in that space and are scaled to the display. */
export const DEFAULT_SCREENSHOT_WIDTH = 1280;
export const STEP_MARKER = "USEAGENT_STEP_OK_";

const X11_KEY_ALIASES: Readonly<Record<string, string>> = {
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  arrowup: "Up",
  backspace: "BackSpace",
  cmd: "Super_L",
  enter: "Return",
  esc: "Escape",
  escape: "Escape",
  pagedown: "Page_Down",
  pageup: "Page_Up",
  return: "Return",
  space: "space",
};

export function x11KeyName(key: string): string {
  return X11_KEY_ALIASES[key.toLowerCase()] ?? key;
}

export function x11KeyCommand(key: string, modifiers: readonly string[] = []): string {
  const normalizedKey = x11KeyName(key);
  if (modifiers.length === 0) {
    return `xdotool keydown --clearmodifiers ${normalizedKey}; sleep 0.1; xdotool keyup ${normalizedKey}; sleep 0.2`;
  }
  return x11ChordCommand(normalizedKey, modifiers.map(x11KeyName));
}

function x11ChordCommand(key: string, modifiers: readonly string[]): string {
  const press = [
    "xdotool keyup ctrl alt shift Super_L",
    "sleep 0.05",
    ...modifiers.map((modifier) => `xdotool keydown ${modifier}`),
    `xdotool key ${key}`,
  ].join(" && ");
  const up = [...modifiers].reverse().map((modifier) => `xdotool keyup ${modifier}`).join("; ");
  return `${press}; status=$?; ${up}; sleep 0.2; test $status -eq 0`;
}

export function x11HotkeyCommand(keys: string): string {
  const parts = keys
    .replaceAll(" ", "")
    .split("+")
    .map(x11KeyName);
  const key = parts.at(-1);
  if (!key) throw new Error("hotkey must contain a key");
  return parts.length === 1
    ? x11KeyCommand(key)
    : x11ChordCommand(key, parts.slice(0, -1));
}

/** A coordinate the model gave in screenshot pixels, scaled to the display at run time. */
function px(value: number): string {
  return `$((${value}*dw/sw))`;
}

/** Bind sw (screenshot width) and dw (display width) for the scaled coordinates. */
export function coordinatePrefix(display: string, screenshotWidth: number): string {
  return `sw=${screenshotWidth}; dw=$(xdpyinfo -display ${display} 2>/dev/null | awk '/dimensions:/{split($2,a,"x"); print a[1]; exit}'); [ -n "$dw" ] || dw=$sw`;
}

const SCROLL_BUTTONS: Record<Direction, number> = { up: 4, down: 5, left: 6, right: 7 };

function typeCommand(text: string, delayMs: number): string {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  const keystrokes = `printf '%s' '${encoded}' | base64 -d | xdotool type --clearmodifiers --delay ${delayMs} --file -`;
  if (text.length <= CLIPBOARD_TEXT_THRESHOLD) return keystrokes;
  // Long text is pasted: a keystroke per character is slow and toolkits drop some. xclip forks
  // to serve the selection; its output is detached so the batch shell can exit.
  return `if command -v xclip >/dev/null 2>&1; then printf '%s' '${encoded}' | base64 -d | xclip -selection clipboard -in >/dev/null 2>&1 && ` +
    `xdotool key --clearmodifiers ctrl+v && sleep 0.3; else ${keystrokes}; fi`;
}

/** Open a URL on a desktop that has no browser relay (a provider-native desktop): through the
 *  address bar of the visible browser window, or a fresh browser when none is open. */
export function addressBarNavigateCommand(url: string, browserExecutable: string | null): string {
  const safeUrl = url.replaceAll("'", "%27");
  const browser = browserExecutable
    ? `'${browserExecutable}'`
    : '"$(command -v google-chrome 2>/dev/null || command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null)"';
  return `win=$(xdotool search --onlyvisible --class chrom 2>/dev/null | tail -n 1); ` +
    `if [ -n "$win" ]; then xdotool windowactivate --sync "$win" && xdotool key --clearmodifiers ctrl+l && sleep 0.2 && ` +
    `${typeCommand(safeUrl, 10)} && xdotool key --clearmodifiers Return; ` +
    `else (setsid ${browser} '${safeUrl}' >/dev/null 2>&1 &) && sleep 2; fi`;
}

function cubeSequenceCommand(action: ComputerSequenceAction): string {
  switch (action.action) {
    case "click": {
      const repeat = action.triple ? "--repeat 3 --delay 80 " : action.double ? "--repeat 2 --delay 100 " : "";
      const click = `xdotool mousemove ${px(action.x)} ${px(action.y)} click ${repeat}${buttonNumber(action.button)}`;
      if (action.modifiers.length === 0) return click;
      const held = action.modifiers.map(x11KeyName);
      return `${held.map((key) => `xdotool keydown ${key}`).join(" && ")} && ${click}; status=$?; ` +
        `${[...held].reverse().map((key) => `xdotool keyup ${key}`).join("; ")}; test $status -eq 0`;
    }
    case "move":
      return `xdotool mousemove ${px(action.x)} ${px(action.y)}`;
    case "drag":
      return `xdotool mousemove ${px(action.startX)} ${px(action.startY)} mousedown 1 ` +
        `mousemove --sync ${px(action.endX)} ${px(action.endY)} mouseup 1`;
    case "type":
      return typeCommand(action.text, action.delayMs);
    case "key": {
      const once = x11KeyCommand(action.key, action.modifiers);
      if (action.repeat === 1) return once;
      return `for _i in $(seq 1 ${action.repeat}); do { ${once}; } || exit 1; done`;
    }
    case "hold_key":
      return `xdotool keydown --clearmodifiers ${x11KeyName(action.key)} && sleep ${(action.durationMs / 1000).toFixed(3)}; ` +
        `xdotool keyup ${x11KeyName(action.key)}`;
    case "hotkey":
      return x11HotkeyCommand(action.keys);
    case "navigate":
      throw new Error("navigate runs over the browser control transport, not the shell");
    case "scroll":
      return `xdotool mousemove ${px(action.x)} ${px(action.y)} click --repeat ${action.amount} ` +
        `--delay 40 ${SCROLL_BUTTONS[action.direction]}`;
    case "wait":
      return `sleep ${(action.ms / 1000).toFixed(3)}`;
  }
}

/** One shell command for a batch: scaled coordinates, and a marker after every action so a
 *  failure names the action that failed. */
export function buildCubeSequenceCommand(
  actions: readonly ComputerSequenceAction[],
  options: { readonly display?: string; readonly screenshotWidth?: number } = {},
): string {
  const steps = actions.map((action, index) => `${cubeSequenceCommand(action)} && printf '%s\\n' ${STEP_MARKER}${index + 1}`);
  return `${coordinatePrefix(options.display ?? DEFAULT_DISPLAY, options.screenshotWidth ?? DEFAULT_SCREENSHOT_WIDTH)}; ${steps.join(" && ")}`;
}

/** Turn a failed batch into a message that names the action, what ran and what did not. */
export function describeSequenceFailure(
  batch: readonly ComputerSequenceAction[],
  offset: number,
  total: number,
  message: string,
): string {
  const completed = (message.match(new RegExp(STEP_MARKER + "\\d+", "g")) ?? []).length;
  const failed = batch[Math.min(completed, batch.length - 1)];
  const index = offset + Math.min(completed, batch.length - 1);
  const detail = message.split("\n").filter((line) => !line.includes(STEP_MARKER)).join("\n").trim();
  const executed = index;
  const skipped = total - index - 1;
  return `Action ${index + 1} of ${total} (${failed?.action ?? "unknown"}) failed${detail ? `: ${detail}` : ""}. ` +
    `${executed} action${executed === 1 ? "" : "s"} before it ran; ${skipped} after it did not. Take a screenshot before continuing.`;
}

/** Shell batches with navigations between them: a URL travels over the browser
 *  control transport, never through keystrokes into the address bar. */
export function sequenceBatches(
  actions: readonly ComputerSequenceAction[],
): readonly ({ readonly shell: readonly ComputerSequenceAction[] } | { readonly navigate: string })[] {
  const batches: ({ shell: ComputerSequenceAction[] } | { navigate: string })[] = [];
  for (const action of actions) {
    if (action.action === "navigate") {
      batches.push({ navigate: action.url });
      continue;
    }
    const last = batches[batches.length - 1];
    if (last && "shell" in last) last.shell.push(action);
    else batches.push({ shell: [action] });
  }
  return batches;
}

export function buttonNumber(button: Button): number {
  switch (button) {
    case "left":
      return 1;
    case "middle":
      return 2;
    case "right":
      return 3;
  }
}
