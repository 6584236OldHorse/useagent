import { describe, expect, test } from "bun:test";
import { desktopFrameConnection } from "./desktop-frame-connection";

describe("desktop frame connection", () => {
  const frame = {} as MessageEventSource;

  test("reads the state the frame's bridge reports", () => {
    expect(desktopFrameConnection({ source: frame, data: { desktopConnected: true } }, frame)).toBe(true);
    expect(desktopFrameConnection({ source: frame, data: { desktopConnected: false } }, frame)).toBe(false);
  });

  test("ignores other windows, other messages and a missing frame", () => {
    const other = {} as MessageEventSource;
    expect(desktopFrameConnection({ source: other, data: { desktopConnected: true } }, frame)).toBeNull();
    expect(desktopFrameConnection({ source: frame, data: { desktopConnected: "yes" } }, frame)).toBeNull();
    expect(desktopFrameConnection({ source: frame, data: null }, frame)).toBeNull();
    expect(desktopFrameConnection({ source: frame, data: "noVNC_connected" }, frame)).toBeNull();
    expect(desktopFrameConnection({ source: null, data: { desktopConnected: true } }, null)).toBeNull();
  });
});
