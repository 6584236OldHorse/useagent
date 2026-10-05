import { expect, mock, test } from "bun:test";

const exposed: Array<[string, Record<string, unknown>]> = [];
const invocations: unknown[][] = [];
const sends: unknown[][] = [];
mock.module("electron", () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: Record<string, unknown>) => exposed.push([name, api]) },
  ipcRenderer: {
    invoke: (...args: unknown[]) => {
      invocations.push(args);
      return Promise.resolve(args[0] === "useagent-desktop:runner-status" ? { state: "online", detail: "Ready", progress: 1 } : undefined);
    },
    send: (...args: unknown[]) => sends.push(args),
  },
}));

test("preload exposes only the frozen desktop bridge", async () => {
  process.argv.push("--useagent-version=0.0.5");
  await import("./preload");
  process.argv.pop();

  expect(exposed).toHaveLength(1);
  expect(exposed[0]![0]).toBe("useagentDesktop");
  const api = exposed[0]![1] as {
    version: string;
    platform: string;
    connectRunner(token: string): Promise<void>;
    runnerStatus(): Promise<unknown>;
    openExternal(url: string): void;
  };
  expect(Object.keys(api).sort()).toEqual(["connectRunner", "openExternal", "platform", "runnerStatus", "version"]);
  expect(api.version).toBe("0.0.5");
  await api.connectRunner("secret-token");
  expect(await api.runnerStatus()).toEqual({ state: "online", detail: "Ready", progress: 1 });
  api.openExternal("https://docs.example");
  expect(invocations).toEqual([
    ["useagent-desktop:connect-runner", "secret-token"],
    ["useagent-desktop:runner-status"],
  ]);
  expect(sends).toEqual([["useagent-desktop:open-external", "https://docs.example"]]);
});
