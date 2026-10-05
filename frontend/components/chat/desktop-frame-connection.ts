/**
 * The desktop frame is sandboxed into an opaque origin, so the pane cannot read
 * its document. The bridge script the backend injects into vnc.html posts
 * `{ desktopConnected }` whenever noVNC's own `noVNC_connected` marker on <html>
 * changes (app/ui.js updateVisualState). The iframe's load event fires seconds
 * earlier, with the page still showing "Connecting...".
 *
 * Returns the reported state for a message from `frame`, or null for any other
 * message. The frame is untrusted: the state only drives the pane's own chrome.
 */
export function desktopFrameConnection(
  event: Pick<MessageEvent, "source" | "data">,
  frame: MessageEventSource | null | undefined,
): boolean | null {
  if (!frame || event.source !== frame) return null;
  const connected: unknown = (event.data as { desktopConnected?: unknown } | null)?.desktopConnected;
  return typeof connected === "boolean" ? connected : null;
}
