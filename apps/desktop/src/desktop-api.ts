import type { RunnerStatus } from "./runner";

export const desktopChannels = {
  connectRunner: "useagent-desktop:connect-runner",
  runnerStatus: "useagent-desktop:runner-status",
  openExternal: "useagent-desktop:open-external",
} as const;

export type DesktopApi = {
  version: string;
  platform: "darwin" | "win32" | "linux";
  connectRunner(token: string): Promise<void>;
  runnerStatus(): Promise<RunnerStatus>;
  openExternal(url: string): void;
};
