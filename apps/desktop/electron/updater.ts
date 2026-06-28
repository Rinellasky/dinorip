import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
import { autoUpdater } from "electron-updater";
import type * as Contracts from "@dinorip/ipc-contracts";
import type {
  UpdateCheckResult,
  OpenUpdatePageResult,
  UpdateState
} from "@dinorip/ipc-contracts";

const CHANNELS = {
  updateState: "dinorip:update-state",
  getUpdateState: "dinorip:get-update-state",
  checkForUpdate: "dinorip:check-for-update",
  openUpdatePage: "dinorip:open-update-page"
} as const satisfies Pick<
  typeof Contracts.IPC_CHANNELS,
  "updateState" | "getUpdateState" | "checkForUpdate" | "openUpdatePage"
>;

const STARTUP_CHECK_DELAY_MS = 15_000;
const UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const RELEASES_LATEST_URL = "https://github.com/maria-rcks/dinorip/releases/latest";
const RELEASES_TAG_URL = "https://github.com/maria-rcks/dinorip/releases/tag/";

let getMainWindow: () => BrowserWindow | null = () => null;
let registered = false;
let checkInFlight = false;
let startupTimer: NodeJS.Timeout | undefined;
let pollTimer: NodeJS.Timeout | undefined;

let updateState: UpdateState = createInitialState();

function createInitialState(): UpdateState {
  const disabledReason = getAutoUpdateDisabledReason();
  return {
    enabled: disabledReason === null,
    status: disabledReason === null ? "idle" : "disabled",
    currentVersion: app.getVersion(),
    availableVersion: null,
    checkedAt: null,
    message: disabledReason,
    canRetry: false
  };
}

function getAutoUpdateDisabledReason(): string | null {
  if (process.env.DINORIP_DISABLE_AUTO_UPDATE === "1") {
    return "Automatic updates are disabled by the DINORIP_DISABLE_AUTO_UPDATE setting.";
  }
  if (!app.isPackaged) {
    return "Automatic updates are only available in packaged builds.";
  }
  if (process.platform === "linux" && !process.env.APPIMAGE) {
    return "Automatic updates on Linux require running the AppImage build.";
  }
  return null;
}

function currentTimestamp(): string {
  return new Date().toISOString();
}

function readVersion(info: unknown): string | null {
  if (typeof info !== "object" || info === null || !("version" in info)) return null;
  const version = (info as { version?: unknown }).version;
  return typeof version === "string" && version.trim().length > 0 ? version : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "The update operation failed.";
}

function broadcastState(): void {
  const windows = new Set(BrowserWindow.getAllWindows());
  const mainWindow = getMainWindow();
  if (mainWindow) windows.add(mainWindow);

  for (const window of windows) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.updateState, updateState);
  }
}

function setUpdateState(next: UpdateState): UpdateState {
  updateState = next;
  broadcastState();
  return updateState;
}

function patchUpdateState(patch: Partial<UpdateState>): UpdateState {
  return setUpdateState({ ...updateState, ...patch });
}

async function showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const window = getMainWindow();
  if (window && !window.isDestroyed()) {
    return dialog.showMessageBox(window, options);
  }
  return dialog.showMessageBox(options);
}

function handleUpdateAvailable(info: unknown): void {
  const version = readVersion(info) ?? updateState.availableVersion;
  patchUpdateState({
    status: "available",
    availableVersion: version,
    checkedAt: currentTimestamp(),
    message: null,
    canRetry: false
  });
}

function handleUpdateNotAvailable(): void {
  patchUpdateState({
    status: "up-to-date",
    availableVersion: null,
    checkedAt: currentTimestamp(),
    message: null,
    canRetry: false
  });
}

function handleUpdaterError(error: unknown): void {
  patchUpdateState({
    status: "error",
    message: errorMessage(error),
    checkedAt: currentTimestamp(),
    canRetry: true
  });
}

async function checkForUpdates(reason: string): Promise<UpdateCheckResult> {
  if (!updateState.enabled || checkInFlight) {
    return { checked: false, state: updateState };
  }

  checkInFlight = true;
  patchUpdateState({
    status: "checking",
    checkedAt: currentTimestamp(),
    message: null,
    canRetry: false
  });

  try {
    await autoUpdater.checkForUpdates();
    return { checked: true, state: updateState };
  } catch (error) {
    console.error(`Failed to check for updates (${reason}):`, error);
    handleUpdaterError(error);
    return { checked: true, state: updateState };
  } finally {
    checkInFlight = false;
  }
}

function updatePageUrl(): string {
  return updateState.availableVersion
    ? `${RELEASES_TAG_URL}v${encodeURIComponent(updateState.availableVersion)}`
    : RELEASES_LATEST_URL;
}

async function openUpdatePage(): Promise<OpenUpdatePageResult> {
  const url = updatePageUrl();
  try {
    await shell.openExternal(url);
    return { opened: true, url, state: updateState };
  } catch (error) {
    const state = patchUpdateState({
      message: errorMessage(error),
      canRetry: true
    });
    return { opened: false, url, state };
  }
}

export async function checkForUpdatesFromMenu(): Promise<void> {
  const result = await checkForUpdates("menu");

  if (!result.checked && !updateState.enabled) {
    await showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: updateState.message ?? "This build cannot check for updates.",
      buttons: ["OK"]
    });
    return;
  }

  if (!result.checked && updateState.status === "checking") {
    await showMessageBox({
      type: "info",
      title: "Already checking",
      message: "DinoRip is already checking for updates.",
      buttons: ["OK"]
    });
    return;
  }

  if (updateState.status === "up-to-date") {
    await showMessageBox({
      type: "info",
      title: "DinoRip is up to date",
      message: `DinoRip ${updateState.currentVersion} is currently the newest version available.`,
      buttons: ["OK"]
    });
    return;
  }

  if (updateState.status === "available") {
    const response = await showMessageBox({
      type: "info",
      title: "Update available",
      message: `DinoRip ${updateState.availableVersion ?? "update"} is available.`,
      detail: "Open GitHub Releases to download the installer for your platform. DinoRip will not install it automatically.",
      buttons: ["Open Downloads", "Later"],
      defaultId: 0,
      cancelId: 1
    });
    if (response.response === 0) {
      const opened = await openUpdatePage();
      if (!opened.opened) {
        await showMessageBox({
          type: "warning",
          title: "Could not open downloads",
          message: "DinoRip could not open the update page.",
          detail: opened.state.message ?? opened.url,
          buttons: ["OK"]
        });
      }
    }
    return;
  }

  if (updateState.status === "error") {
    await showMessageBox({
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: updateState.message ?? "An unknown error occurred.",
      buttons: ["OK"]
    });
  }
}

function scheduleAutomaticChecks(): void {
  startupTimer = setTimeout(() => void checkForUpdates("startup"), STARTUP_CHECK_DELAY_MS);
  startupTimer.unref?.();

  pollTimer = setInterval(() => void checkForUpdates("poll"), UPDATE_POLL_INTERVAL_MS);
  pollTimer.unref?.();
}

export function configureUpdates(getWindow: () => BrowserWindow | null): void {
  getMainWindow = getWindow;
  if (registered) return;
  registered = true;

  updateState = createInitialState();

  ipcMain.handle(CHANNELS.getUpdateState, async (): Promise<UpdateState> => updateState);
  ipcMain.handle(CHANNELS.checkForUpdate, async (): Promise<UpdateCheckResult> => checkForUpdates("renderer"));
  ipcMain.handle(CHANNELS.openUpdatePage, async (): Promise<OpenUpdatePageResult> => openUpdatePage());

  if (!updateState.enabled) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("update-available", handleUpdateAvailable);
  autoUpdater.on("update-not-available", handleUpdateNotAvailable);
  autoUpdater.on("error", handleUpdaterError);

  app.once("before-quit", () => {
    if (startupTimer) clearTimeout(startupTimer);
    if (pollTimer) clearInterval(pollTimer);
  });

  scheduleAutomaticChecks();
}
