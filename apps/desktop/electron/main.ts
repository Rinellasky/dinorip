import { app, BrowserWindow, Menu, nativeImage, shell } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import path from "node:path";
import sharp from "sharp";
import { registerIpc } from "./ipc";
import { checkForUpdatesFromMenu, configureUpdates } from "./updater";
import type { MenuCommand } from "@dinorip/ipc-contracts";

// Set before the app is ready so the menu bar, About panel, and userData path
// all use the product name instead of Electron's default. (Packaged builds get
// this from build.productName; this covers dev.)
app.setName("DinoRip");

let mainWindow: BrowserWindow | null = null;

const MENU_CHANNEL = "dinorip:menu-command";

function sendMenuCommand(command: MenuCommand): void {
  mainWindow?.webContents.send(MENU_CHANNEL, command);
}

function installApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  const checkForUpdates = () => void checkForUpdatesFromMenu();
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" },
            { label: "Check for Updates...", click: checkForUpdates },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" }
          ]
        } satisfies MenuItemConstructorOptions]
      : []),
    {
      label: "File",
      submenu: [
        { label: "Open Project...", accelerator: "CmdOrCtrl+O", click: () => sendMenuCommand("open-project") },
        { label: "Save Project...", accelerator: "CmdOrCtrl+S", click: () => sendMenuCommand("save-project") },
        { type: "separator" },
        { label: "Load Image...", accelerator: "CmdOrCtrl+Shift+O", click: () => sendMenuCommand("load-image") },
        { type: "separator" },
        { label: "Export Selected Texture...", click: () => sendMenuCommand("export-selected") },
        { label: "Export All Textures...", click: () => sendMenuCommand("export-all") },
        { label: "Export Atlas...", click: () => sendMenuCommand("export-atlas") },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => sendMenuCommand("undo") },
        { label: "Redo", accelerator: isMac ? "Shift+Cmd+Z" : "Ctrl+Y", click: () => sendMenuCommand("redo") },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { type: "separator" },
        { label: "Select All", accelerator: "CmdOrCtrl+A", click: () => sendMenuCommand("select-all") }
      ]
    },
    {
      label: "View",
      submenu: [
        { label: "Toggle Full Screen", accelerator: "CmdOrCtrl+F", click: () => sendMenuCommand("toggle-fullscreen") },
        ...(app.isPackaged ? [] : [
          { type: "separator" } as MenuItemConstructorOptions,
          { role: "reload" } as MenuItemConstructorOptions,
          { role: "toggleDevTools" } as MenuItemConstructorOptions
        ])
      ]
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        ...(!isMac ? [{ label: "Check for Updates...", click: checkForUpdates } satisfies MenuItemConstructorOptions] : []),
        ...(!isMac ? [{ type: "separator" } satisfies MenuItemConstructorOptions] : []),
        {
          label: "DinoRip on GitHub",
          click: () => void shell.openExternal("https://github.com/maria-rcks/dinorip")
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function configureAboutPanel(): void {
  app.setAboutPanelOptions({
    applicationName: "DinoRip",
    applicationVersion: app.getVersion(),
    iconPath: appIconPath()
  });
}

// The runtime/Dock icon uses the pre-rounded squircle: macOS does not
// auto-squircle a programmatically-set Dock icon (unlike a packaged app's
// bundle icon), so we ship the rounded shape ourselves. It's an extraResource
// when packaged and lives under build/ during development.
function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon-rounded.png")
    : path.join(app.getAppPath(), "build", "icon-rounded.png");
}

// Dev-only icon: invert the normal rounded icon colors so the build you're
// editing (pnpm dev) is obvious at a glance next to any installed release.
let devIcon: Electron.NativeImage | null = null;

async function buildDevIcon(): Promise<Electron.NativeImage | null> {
  try {
    const buf = await sharp(appIconPath())
      .ensureAlpha()
      .negate({ alpha: false })
      .png()
      .toBuffer();
    const img = nativeImage.createFromBuffer(buf);
    return img.isEmpty() ? null : img;
  } catch (error) {
    console.error("Failed to build dev icon:", error);
    return null;
  }
}

function createWindow(): void {
  const isMac = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: "#f4f4f2",
    show: false,
    title: "DinoRip",
    icon: devIcon ?? appIconPath(),
    // Drop the native chrome and let the renderer's header act as the title bar.
    // On macOS keep the traffic lights, nudged to sit inside the 22px header.
    titleBarStyle: isMac ? "hidden" : "default",
    ...(isMac ? { trafficLightPosition: { x: 10, y: 4 } } : {}),
    webPreferences: {
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Block in-app navigation and open any external links in the user's browser.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http:") || url.startsWith("https:")) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(async () => {
  // In dev, invert the icon colors so it's obvious which build is running;
  // packaged builds use the clean bundle icon.
  if (!app.isPackaged) devIcon = await buildDevIcon();

  // In dev the macOS dock shows the generic Electron icon; packaged builds use
  // the bundle icon instead. Set it explicitly so dev matches the brand.
  if (process.platform === "darwin" && !app.isPackaged && app.dock) {
    const icon = devIcon ?? nativeImage.createFromPath(appIconPath());
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }

  // Register IPC once for the app lifetime; handlers resolve the current window
  // lazily, so re-creating the window on macOS does not double-register.
  registerIpc(() => mainWindow);
  configureUpdates(() => mainWindow);
  configureAboutPanel();
  installApplicationMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  console.error("Failed to initialize app:", error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
