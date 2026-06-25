import { app, BrowserWindow, nativeImage, shell } from "electron";
import path from "node:path";
import sharp from "sharp";
import { registerIpc } from "./ipc";

// Set before the app is ready so the menu bar, About panel, and userData path
// all use the product name instead of Electron's default. (Packaged builds get
// this from build.productName; this covers dev.)
app.setName("DinoRip");

let mainWindow: BrowserWindow | null = null;

// The runtime/Dock icon uses the pre-rounded squircle: macOS does not
// auto-squircle a programmatically-set Dock icon (unlike a packaged app's
// bundle icon), so we ship the rounded shape ourselves. It's an extraResource
// when packaged and lives under build/ during development.
function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon-rounded.png")
    : path.join(app.getAppPath(), "build", "icon-rounded.png");
}

// Dev-only "police tape" badge: composite a yellow caution-tape band reading
// "DEV" across the app icon so the build you're editing (pnpm dev) is obvious
// at a glance in the Dock / taskbar next to any installed release. Generated at
// runtime from the rounded icon so it always tracks the real brand mark.
let devIcon: Electron.NativeImage | null = null;

async function buildDevIcon(): Promise<Electron.NativeImage | null> {
  const SIZE = 1024;
  const cy = SIZE * 0.7;       // band sits across the lower third
  const bandH = 210;
  const edge = 12;            // black tape borders
  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
    <g transform="rotate(-18 ${SIZE / 2} ${cy})">
      <rect x="-220" y="${cy - bandH / 2}" width="${SIZE + 440}" height="${bandH}" fill="#F2C200"/>
      <rect x="-220" y="${cy - bandH / 2}" width="${SIZE + 440}" height="${edge}" fill="#141414"/>
      <rect x="-220" y="${cy + bandH / 2 - edge}" width="${SIZE + 440}" height="${edge}" fill="#141414"/>
      <text x="${SIZE / 2}" y="${cy}" text-anchor="middle" dominant-baseline="central"
            font-family="Helvetica, Arial, sans-serif" font-size="150" font-weight="900"
            letter-spacing="34" fill="#141414">DEV</text>
    </g>
  </svg>`;
  try {
    const iconBuf = await sharp(appIconPath()).png().toBuffer();
    // Clip the tape to the icon's silhouette (dest-in against the icon's own
    // alpha) so it never spills into the transparent gutter around the squircle.
    const tape = await sharp(Buffer.from(overlay))
      .composite([{ input: iconBuf, blend: "dest-in" }])
      .png()
      .toBuffer();
    const buf = await sharp(iconBuf)
      .composite([{ input: tape }])
      .png()
      .toBuffer();
    const img = nativeImage.createFromBuffer(buf);
    return img.isEmpty() ? null : img;
  } catch (error) {
    console.error("Failed to build dev icon badge:", error);
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
  // In dev, badge the icon with the "DEV" caution tape so it's obvious which
  // build is running; packaged builds use the clean bundle icon.
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
