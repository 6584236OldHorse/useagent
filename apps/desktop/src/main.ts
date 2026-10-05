import {
  app,
  type BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MessageBoxOptions,
  nativeImage,
  safeStorage,
  shell,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { autoUpdater } from "electron-updater";
import { join } from "node:path";
import { desktopChannels } from "./desktop-api";
import { createRunnerController, stopRunnerBeforeQuit, type RunnerStatus } from "./runner";
import { desktopLoadErrorMessage, externalUrl, planeManifest, planeUrl, runnerToken, trustedIpcSender } from "./security";
import { createTokenStore } from "./token-store";
import { createDesktopWindow } from "./window";
import { createDesktopSignIn, desktopOrganizationLabel, type DesktopOrganization } from "./sign-in";
import { createDesktopAuthClient } from "./auth-client";

const keepRunningInBackground = process.env.USEAGENT_KEEP_RUNNING_IN_BACKGROUND === "1";
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let quitAfterRunnerStops = false;
let signIn: ReturnType<typeof createDesktopSignIn> | undefined;

function completeSignIn(url: string): void {
  if (!signIn) { dialog.showErrorBox("Sign-in expired", "Open useAgent and start sign-in again."); return; }
  void signIn.complete(url).catch(() => dialog.showErrorBox("Sign-in did not complete", "Return to useAgent and try signing in again."));
}

app.on("open-url", (event, url) => { event.preventDefault(); completeSignIn(url); });

function runnerBinary(): string {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
    throw new Error("This desktop build does not include a runner for this platform.");
  }
  return join(process.resourcesPath, `useagent-runner-darwin-${process.arch}`);
}

function trusted(event: IpcMainInvokeEvent | IpcMainEvent, origin: string): void {
  if (!trustedIpcSender(event.senderFrame?.url ?? "", event.senderFrame === event.sender.mainFrame, origin)) {
    throw new Error("Unauthorized desktop request.");
  }
}

async function loadManifest(origin: string): Promise<{ image: string }> {
  try {
    const response = await fetch(`${origin}/api/config`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error();
    return planeManifest(await response.json());
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("This desktop requires")) throw error;
    throw new Error(`Could not verify desktop compatibility with ${origin}.`);
  }
}

function configureUpdater(): void {
  const reportFailure = (): void => console.error("[desktop:update] UPDATE_FAILED");
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on("error", reportFailure);
  if (!app.isPackaged) return;
  const check = () => void autoUpdater.checkForUpdatesAndNotify().catch(reportFailure);
  check();
  setInterval(check, 4 * 60 * 60_000).unref();
}

async function startDesktop(): Promise<void> {
  const plane = planeUrl(process.env.USEAGENT_PLANE_URL);
  const manifest = await loadManifest(plane.origin);
  const runnerStore = createTokenStore(join(app.getPath("userData"), "runner-token"), plane.origin, safeStorage);
  let shellStatus: RunnerStatus | undefined;
  const runner = createRunnerController({
    binary: runnerBinary(),
    plane: plane.origin,
    shareLogins: [],
    onTokenRejected: () => void runnerStore.remove(),
  });
  app.on("before-quit", (event) => {
    quitting = true;
    if (quitAfterRunnerStops) return;
    event.preventDefault();
    void stopRunnerBeforeQuit(
      () => runner.stop(),
      () => {
        quitAfterRunnerStops = true;
        app.quit();
      },
    ).catch(() => { quitting = false; });
  });

  try {
    const token = await runnerStore.read();
    if (token) await runner.start(token);
  } catch {
    shellStatus = { state: "error", detail: "Secure runner token storage could not be read.", progress: 0 };
  }

  ipcMain.handle(desktopChannels.connectRunner, async (event, token: unknown) => {
    trusted(event, plane.origin);
    const validToken = runnerToken(token);
    await runnerStore.write(validToken);
    shellStatus = undefined;
    await runner.restart(validToken);
  });
  ipcMain.handle(desktopChannels.runnerStatus, async (event) => {
    trusted(event, plane.origin);
    return shellStatus ?? runner.getStatus();
  });
  ipcMain.on(desktopChannels.openExternal, (event, url: unknown) => {
    try {
      trusted(event, plane.origin);
      if (typeof url === "string" && url === new URL("/desktop-auth", plane).href) {
        void signIn?.begin().catch(() => dialog.showErrorBox("Browser unavailable", "Could not open the sign-in browser."));
        return;
      }
      void shell.openExternal(externalUrl(url)).catch(() => undefined);
    } catch {
      // Ignore requests outside the trusted top frame.
    }
  });

  const window = createDesktopWindow(plane);
  mainWindow = window;
  signIn = createDesktopSignIn(
    plane,
    window,
    createDesktopAuthClient(plane, app.getPath("userData")),
    async (organizations: readonly DesktopOrganization[]) => {
      const options: MessageBoxOptions = {
        type: "question",
        title: "Choose workspace",
        message: "Choose the workspace to open in useAgent.",
        buttons: [...organizations.map(desktopOrganizationLabel), "Cancel"],
        defaultId: 0,
        cancelId: organizations.length,
        noLink: true,
      };
      const result = window.isVisible()
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
      return organizations[result.response]?.id;
    },
  );
  // A failed restore has already cleared Chromium's auth cookies; only a verified session opens the product.
  const restored = await signIn.restore();
  if (app.isPackaged) app.setAsDefaultProtocolClient("useagent");
  mainWindow.on("close", (event) => {
    if (keepRunningInBackground && !quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  const trayImage = nativeImage.createFromPath(join(app.getAppPath(), "resources/trayTemplate.svg"));
  trayImage.setTemplateImage(true);
  tray = new Tray(trayImage);
  tray.setToolTip("useAgent");
  const refreshTray = (): void => {
    const status = shellStatus ?? runner.getStatus();
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Runner: ${status.state}`, enabled: false },
        { label: "Sandboxes: Unknown", enabled: false },
        { label: `Image: ${manifest.image}`, enabled: false },
        { type: "separator" },
        { label: mainWindow?.isVisible() ? "Hide useAgent" : "Open useAgent", click: () => (mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show()) },
        { label: "Quit", click: () => app.quit() },
      ]),
    );
  };
  refreshTray();
  setInterval(refreshTray, 1_000).unref();
  configureUpdater();
  await mainWindow.loadURL(restored ? plane.href : new URL("/login", plane).href);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const callback = argv.find(argument => argument.startsWith("useagent:"));
    if (callback) completeSignIn(callback);
    mainWindow?.show();
    mainWindow?.focus();
  });
  app.whenReady().then(startDesktop).catch((error: unknown) => {
    dialog.showErrorBox("useAgent could not start", desktopLoadErrorMessage(error));
    app.quit();
  });
}

app.on("window-all-closed", () => {
  if (!keepRunningInBackground) app.quit();
});
