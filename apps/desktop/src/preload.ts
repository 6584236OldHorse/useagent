import { contextBridge, ipcRenderer } from "electron";
import { desktopChannels, type DesktopApi } from "./desktop-api";

const versionArgument = process.argv.find((argument) => argument.startsWith("--useagent-version="));
const version = versionArgument?.slice("--useagent-version=".length);
if (!version) throw new Error("Desktop version is unavailable.");
const platform = process.platform;
if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
  throw new Error("Unsupported desktop platform.");
}

const api: DesktopApi = {
  version,
  platform,
  connectRunner: (token) => ipcRenderer.invoke(desktopChannels.connectRunner, token),
  runnerStatus: () => ipcRenderer.invoke(desktopChannels.runnerStatus),
  openExternal: (url) => ipcRenderer.send(desktopChannels.openExternal, url),
};

contextBridge.exposeInMainWorld("useagentDesktop", api);
