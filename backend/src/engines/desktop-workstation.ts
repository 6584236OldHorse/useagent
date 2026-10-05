import { BROWSER_CDP_ENDPOINT, BROWSER_DISPLAY } from "./browser-mcp";
import {
  BROWSER_LAUNCH_SCRIPT,
  desktopCdpRelayProbeCommand,
  providerCdpRelayProbeCommand,
} from "./desktop-cdp-relay";

export const DESKTOP_PORT = 6080;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export const DESKTOP_REQUIRED_BINARIES = [
  "Xorg",
  "budgie-daemon",
  "budgie-panel",
  "budgie-wm",
  "dbus-launch",
  "dconf",
  "gnome-terminal",
  "node",
  "pcmanfm",
  "pgrep",
  "websockify",
  "x11vnc",
  "xdotool",
  "xdpyinfo",
] as const;

/** The settings daemon lives outside PATH on Debian. */
export const DESKTOP_SETTINGS_DAEMON = "/usr/libexec/gsd-xsettings";

export function rfbProbeCommand(): string {
  // curl's telnet transport exits 28 after reading the banner when x11vnc keeps
  // the protocol socket open. A direct socket read gives the readiness check
  // one unambiguous success condition and no shell-pipeline exit-code trap.
  return "python3 -c \"import socket; s=socket.create_connection(('127.0.0.1',5900),1); assert s.recv(4)==b'RFB '\"";
}

/** The desktop session is whole: window manager, panel, daemon and the desktop icons. */
export function desktopSessionProbeCommand(): string {
  return ["budgie-wm", "budgie-panel", "budgie-daemon", "pcmanfm"]
    .map((process) => `pgrep -x ${process} >/dev/null`)
    .join(" && ");
}

/** The session script: Budgie's components started directly under one session bus. Budgie's own
 *  session manager needs logind and polkit, which a sandbox does not have. */
export function buildDesktopSessionScript(): string {
  return [
    "#!/bin/sh",
    `${DESKTOP_SETTINGS_DAEMON} >"$HOME/.skynet/gsd-xsettings.log" 2>&1 &`,
    'budgie-daemon >"$HOME/.skynet/budgie-daemon.log" 2>&1 &',
    'budgie-wm >"$HOME/.skynet/budgie-wm.log" 2>&1 &',
    'for i in $(seq 1 80); do xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q "window id" && break; sleep 0.25; done',
    'budgie-panel >"$HOME/.skynet/budgie-panel.log" 2>&1 &',
    'pcmanfm --desktop --profile useagent >"$HOME/.skynet/pcmanfm.log" 2>&1 &',
    "wait",
    "",
  ].join("\n");
}

const LEGACY_CHROME_PIPE_PIDS_COMMAND =
  "ps -eo pid=,comm=,args= | awk '$2 ~ /(chrome|chromium)/ && /--remote-debugging-pipe/ {print $1}'";
const LEGACY_CHROME_PIPE_GONE_COMMAND = `test -z "$(${LEGACY_CHROME_PIPE_PIDS_COMMAND})"`;
const CDP_PORT_CLOSED_COMMAND =
  "python3 -c \"import socket,sys; s=socket.socket(); s.settimeout(1); sys.exit(1 if s.connect_ex(('127.0.0.1',9222)) == 0 else 0)\"";

/** The one-shot Chrome start the launcher runs first and the relay runs on demand. */
export function buildBrowserLaunchScript(): string {
  return [
    "#!/bin/sh",
    `export DISPLAY=${BROWSER_DISPLAY}`,
    'mkdir -p "$HOME/.skynet/browser-profile"',
    "browser=$(command -v google-chrome 2>/dev/null || command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null)",
    'exec "$browser" --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check ' +
      "--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 " +
      "'--remote-allow-origins=*' " +
      '--user-data-dir="$HOME/.skynet/browser-profile" --restore-last-session --start-maximized about:blank ' +
      '>>"$HOME/.skynet/chrome.log" 2>&1',
    "",
  ].join("\n");
}

/** One long-lived process group owns the virtual display, Budgie workstation, browser,
 * VNC server, and noVNC bridge. The browser is deliberately NOT owned by an MCP
 * child, so restarting OpenCode/Claude/Codex or their MCP transport cannot close
 * the user's tabs. Chrome remains loopback-only. The provider-facing relay admits
 * only bounded page CDP routes and requires a per-sandbox bearer token in addition
 * to the provider preview credential. x11vnc also remains loopback-only and reaches
 * the browser through useAgent's authenticated same-origin desktop proxy. */
export function buildDesktopLaunchCommand(): string {
  return [
    "set -eu",
    `export DISPLAY=${BROWSER_DISPLAY}`,
    'mkdir -p "$HOME/.skynet"',
    // Any earlier desktop goes first: the one whose pid is recorded (its process group) and
    // every service by name, so a relaunch never stacks on a live display. Names only, and
    // the browser and relay by their binaries: this shell's own command text has the same words.
    'old=$(cat "$HOME/.skynet/desktop.pid" 2>/dev/null || true)',
    '[ -n "$old" ] && [ "$old" != "$$" ] && { kill -TERM -- "-$old" 2>/dev/null || true; }',
    "for name in websockify x11vnc budgie-panel budgie-wm budgie-daemon pcmanfm gsd-xsettings dbus-launch; do pkill -x $name 2>/dev/null || true; done",
    "ps -eo pid=,comm=,args= | awk '$2 ~ /^(node|chrome|chromium)/ && /(cdp-relay\\.mjs|--remote-debugging-port=9222)/ {print $1}' | xargs -r kill -TERM 2>/dev/null || true",
    "pkill -x Xorg 2>/dev/null || true",
    "for i in $(seq 1 40); do xdpyinfo -display :1 >/dev/null 2>&1 || break; sleep 0.25; done",
    "xdpyinfo -display :1 >/dev/null 2>&1 && { pkill -KILL -x Xorg 2>/dev/null || true; sleep 0.5; }",
    // Xorg clears a stale lock itself; on a non-root image the lock is root's and stays.
    "rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true",
    'echo $$ >"$HOME/.skynet/desktop.pid"',
    "export XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=Budgie:GNOME LANG=C.UTF-8",
    // A system bus, best effort: the components only warn without one, but the terminal's service needs it.
    "pgrep -x dbus-daemon >/dev/null 2>&1 || { mkdir -p /run/dbus && dbus-daemon --system --fork >/dev/null 2>&1 || true; }",
    // A real X server on the dummy driver (1920x1080 at 60 Hz from the image's xorg.conf.d).
    'Xorg :1 -noreset -nolisten tcp -ac >"$HOME/.skynet/xorg.log" 2>&1 &',
    "for i in $(seq 1 40); do xdpyinfo -display :1 >/dev/null 2>&1 && break; sleep 0.25; done",
    "xdpyinfo -display :1 >/dev/null 2>&1",
    `printf '%s' ${shellQuote(buildDesktopSessionScript())} >"$HOME/.skynet/desktop-session.sh"`,
    'chmod +x "$HOME/.skynet/desktop-session.sh"',
    'dbus-launch --exit-with-session "$HOME/.skynet/desktop-session.sh" >"$HOME/.skynet/desktop-session.log" 2>&1 &',
    `for i in $(seq 1 120); do ${desktopSessionProbeCommand()} && break; sleep 0.25; done`,
    desktopSessionProbeCommand(),
    // One-time migration from the old MCP-owned Chrome (`remote-debugging-pipe`).
    // Match only Chrome's process name so this shell cannot kill itself even
    // though its command text contains the same flag.
    `${LEGACY_CHROME_PIPE_PIDS_COMMAND} | xargs -r kill -TERM`,
    `for i in $(seq 1 20); do ${LEGACY_CHROME_PIPE_GONE_COMMAND} && ${CDP_PORT_CLOSED_COMMAND} && break; sleep 0.25; done`,
    LEGACY_CHROME_PIPE_GONE_COMMAND,
    CDP_PORT_CLOSED_COMMAND,
    // Chrome is started once here and on demand afterwards by the relay, when a
    // browser tool or the plane needs it. A window the user closes stays closed.
    `printf '%s' ${shellQuote(buildBrowserLaunchScript())} >"${BROWSER_LAUNCH_SCRIPT}"`,
    `chmod +x "${BROWSER_LAUNCH_SCRIPT}"`,
    `sh "${BROWSER_LAUNCH_SCRIPT}" &`,
    `for i in $(seq 1 80); do curl -fsS -m 1 -o /dev/null ${BROWSER_CDP_ENDPOINT}/json/version && break; sleep 0.25; done`,
    `curl -fsS -m 3 -o /dev/null ${BROWSER_CDP_ENDPOINT}/json/version`,
    'node "$HOME/.skynet/cdp-relay.mjs" >>"$HOME/.skynet/cdp-relay.log" 2>&1 &',
    `for i in $(seq 1 40); do ${desktopCdpRelayProbeCommand()} && break; sleep 0.25; done`,
    desktopCdpRelayProbeCommand(),
    'x11vnc -display :1 -localhost -nopw -forever -shared -rfbport 5900 >"$HOME/.skynet/x11vnc.log" 2>&1 &',
    `for i in $(seq 1 40); do ${rfbProbeCommand()} && break; sleep 0.25; done`,
    rfbProbeCommand(),
    "exec websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900",
  ].join("\n");
}

/** The launcher as the file the image installs; the boot runs it once the runtime is warm. */
export function buildDesktopLaunchScript(): string {
  return `#!/bin/sh\n# useagent-desktop-launch: generated by backend/src/engines/desktop-workstation.ts; do not edit.\n${buildDesktopLaunchCommand()}\n`;
}

/** Marker under $HOME/.skynet while the image's own desktop boot is still running. */
export const DESKTOP_BOOT_MARKER_NAME = "desktop-boot";

/** The desktop is ready without a running browser: the relay starts one when it is needed. */
export function buildDesktopReadinessCommand(): string {
  return (
    `curl -fsS -m 3 -o /dev/null http://127.0.0.1:${DESKTOP_PORT}/vnc.html && ` +
    `${rfbProbeCommand()} && ` +
    `${desktopSessionProbeCommand()} && ` +
    `${desktopCdpRelayProbeCommand()} && ` +
    providerCdpRelayProbeCommand()
  );
}
