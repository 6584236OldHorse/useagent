import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UseAgentDesktopBridge } from "./desktop-bridge";
import {
  RunLocationMenu,
  RunLocationPanel,
  defaultRunLocation,
  isRunLocationShortcut,
  runLocationShortcutHint,
  toggledRunLocation,
} from "./run-location-menu";

const bridge: UseAgentDesktopBridge = {
  version: "1.0.0",
  platform: "darwin",
  connectRunner: async () => {},
  runnerStatus: async () => ({ state: "online" }),
  openExternal: () => {},
};

describe("run location menu", () => {
  test("defaults to Local only while this machine's runner can take work", () => {
    expect(defaultRunLocation({ state: "online" })).toBe("local");
    for (const state of ["starting", "pulling", "offline", "error"] as const) {
      expect(defaultRunLocation({ state })).toBe("cloud");
    }
    expect(defaultRunLocation(null)).toBe("cloud");
    expect(toggledRunLocation("local")).toBe("cloud");
    expect(toggledRunLocation("cloud")).toBe("local");
  });

  test("the shortcut is the command key with the apostrophe, named for the platform", () => {
    expect(isRunLocationShortcut({ key: "'", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isRunLocationShortcut({ key: "'", metaKey: false, ctrlKey: true })).toBe(true);
    expect(isRunLocationShortcut({ key: "'", metaKey: false, ctrlKey: false })).toBe(false);
    expect(isRunLocationShortcut({ key: "k", metaKey: true, ctrlKey: false })).toBe(false);
    expect(runLocationShortcutHint("darwin")).toBe("Use ⌘' to switch");
    expect(runLocationShortcutHint("win32")).toBe("Use Ctrl+' to switch");
  });

  test("renders only under the desktop bridge, naming the current location", () => {
    expect(renderToStaticMarkup(<RunLocationMenu bridge={null} location="local" onChange={() => {}} />)).toBe("");
    const local = renderToStaticMarkup(<RunLocationMenu bridge={bridge} location="local" onChange={() => {}} />);
    expect(local).toContain('aria-label="Run location: Local"');
    // Before the runner status is read, an unmade choice shows as Cloud.
    const unchosen = renderToStaticMarkup(<RunLocationMenu bridge={bridge} location={null} onChange={() => {}} />);
    expect(unchosen).toContain('aria-label="Run location: Cloud"');
    const held = renderToStaticMarkup(<RunLocationMenu bridge={bridge} location="cloud" onChange={() => {}} disabled />);
    expect(held).toContain('disabled=""');
  });

  test("the panel offers Local with the machine's name and Cloud, checks the active one and shows the hint", () => {
    const panel = renderToStaticMarkup(
      <RunLocationPanel location="local" onChange={() => {}} machineName="This Mac" machineOnline platform="darwin" />,
    );
    // Static markup escapes the apostrophe in the hint.
    for (const text of ["Local", "Cloud", "This Mac", "A hosted computer", "Use ⌘&#x27; to switch"]) {
      expect(panel).toContain(text);
    }
    expect(panel.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(panel.match(/data-testid="run-location-check"/g)).toHaveLength(1);
    // The checked row is the Local row: its label follows the attribute before the next row starts.
    const pressed = panel.slice(panel.indexOf('aria-pressed="true"'));
    expect(pressed.indexOf("Local")).toBeLessThan(pressed.indexOf('aria-pressed="false"'));
    expect(panel).not.toContain("not connected");

    const away = renderToStaticMarkup(
      <RunLocationPanel location="cloud" onChange={() => {}} machineName="This Mac" machineOnline={false} platform="linux" />,
    );
    expect(away).toContain("This Mac, not connected");
    expect(away).toContain("Use Ctrl+&#x27; to switch");
    const checked = away.slice(away.indexOf('aria-pressed="true"'));
    expect(checked.indexOf("Cloud")).toBeLessThan(checked.indexOf("Local") === -1 ? Infinity : checked.indexOf("Local"));
  });
});
