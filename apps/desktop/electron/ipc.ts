import { BrowserWindow, dialog, ipcMain } from "electron";
import type { OpenDialogOptions, SaveDialogOptions } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type * as Contracts from "@dinorip/ipc-contracts";
import type {
  ExportAllPngRequest,
  IpcPixelImage,
  OpenProjectResult,
  OpenImagesResult,
  SavePngRequest,
  SaveProjectRequest,
  SaveResult
} from "@dinorip/ipc-contracts";

// Inlined so the compiled main process carries no runtime require of the
// workspace package — that keeps electron-builder packaging independent of
// pnpm workspace symlink resolution. Kept in sync with @dinorip/ipc-contracts
// at compile time via the erased type-only import below.
const IPC_CHANNELS = {
  openImages: "dinorip:open-images",
  savePng: "dinorip:save-png",
  exportAllPng: "dinorip:export-all-png",
  saveProject: "dinorip:save-project",
  openProject: "dinorip:open-project",
  toggleFullscreen: "dinorip:toggle-fullscreen",
  menuCommand: "dinorip:menu-command"
} as const satisfies typeof Contracts.IPC_CHANNELS;

const imageFilters = [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }];
const projectFilters = [{ name: "DinoRip Project", extensions: ["dr"] }];
let currentProjectPath: string | undefined;

/**
 * Registers IPC handlers exactly once. Handlers resolve the active window
 * lazily through `getWindow` so they keep working after the window is closed
 * and recreated (macOS dock reactivate). ipcMain.handle throws if a channel is
 * registered twice, so this must not be called per-window.
 */
export function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC_CHANNELS.openImages, async (): Promise<OpenImagesResult> => {
    const result = await showOpen(getWindow(), {
      title: "Load Image",
      filters: imageFilters,
      properties: ["openFile", "multiSelections"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, images: [] };
    }

    const images = await Promise.all(result.filePaths.map(async (filePath) => {
      const decoded = await decodeImage(filePath);
      return {
        ...decoded,
        path: filePath,
        name: path.basename(filePath)
      };
    }));

    return { canceled: false, images };
  });

  ipcMain.handle(IPC_CHANNELS.savePng, async (_event, request: SavePngRequest): Promise<SaveResult> => {
    assertValidImage(request.image);
    const result = await showSave(getWindow(), {
      title: "Export PNG",
      defaultPath: ensurePngName(request.defaultName),
      filters: [{ name: "PNG", extensions: ["png"] }]
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true, paths: [] };
    }

    await encodePngToFile(request.image, result.filePath);
    return { canceled: false, paths: [result.filePath] };
  });

  ipcMain.handle(IPC_CHANNELS.exportAllPng, async (_event, request: ExportAllPngRequest): Promise<SaveResult> => {
    if (request.images.length === 0) return { canceled: true, paths: [] };
    request.images.forEach(assertValidImage);

    const result = await showOpen(getWindow(), {
      title: "Export Folder",
      properties: ["openDirectory", "createDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0 || !result.filePaths[0]) {
      return { canceled: true, paths: [] };
    }

    const folder = result.filePaths[0];
    await fs.mkdir(folder, { recursive: true });
    const paths = request.images.map((_image, index) => path.join(folder, `texture_${index}.png`));
    await Promise.all(request.images.map((image, index) => encodePngToFile(image, paths[index]!)));

    return { canceled: false, paths };
  });

  ipcMain.handle(IPC_CHANNELS.saveProject, async (_event, request: SaveProjectRequest): Promise<SaveResult> => {
    const knownPath = request.path ?? currentProjectPath;
    if (knownPath) {
      const filePath = ensureProjectName(knownPath);
      await fs.writeFile(filePath, request.contents, "utf8");
      currentProjectPath = filePath;
      return { canceled: false, paths: [filePath] };
    }

    const result = await showSave(getWindow(), {
      title: "Save Project",
      defaultPath: ensureProjectName(request.defaultName),
      filters: projectFilters
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true, paths: [] };
    }

    const filePath = ensureProjectName(result.filePath);
    await fs.writeFile(filePath, request.contents, "utf8");
    currentProjectPath = filePath;
    return { canceled: false, paths: [filePath] };
  });

  ipcMain.handle(IPC_CHANNELS.openProject, async (): Promise<OpenProjectResult> => {
    const result = await showOpen(getWindow(), {
      title: "Open Project",
      filters: projectFilters,
      properties: ["openFile"]
    });

    if (result.canceled || result.filePaths.length === 0 || !result.filePaths[0]) {
      return { canceled: true };
    }

    const filePath = result.filePaths[0];
    currentProjectPath = filePath;
    return {
      canceled: false,
      path: filePath,
      contents: await fs.readFile(filePath, "utf8")
    };
  });

  ipcMain.handle(IPC_CHANNELS.toggleFullscreen, (): boolean => {
    const window = getWindow();
    if (!window) return false;
    const next = !window.isFullScreen();
    window.setFullScreen(next);
    return next;
  });
}

function showOpen(window: BrowserWindow | null, options: OpenDialogOptions) {
  return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options);
}

function showSave(window: BrowserWindow | null, options: SaveDialogOptions) {
  return window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options);
}

/**
 * The renderer is trusted, but a malformed buffer would make sharp throw an
 * opaque native error. Validate the contract up front so failures are clear.
 */
function assertValidImage(image: IpcPixelImage): void {
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid image dimensions: ${width} x ${height}`);
  }
  const expected = width * height * 4;
  if (data.byteLength !== expected) {
    throw new Error(`Invalid RGBA buffer length. Expected ${expected}, got ${data.byteLength}.`);
  }
}

async function decodeImage(filePath: string): Promise<IpcPixelImage> {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    width: info.width,
    height: info.height,
    data: new Uint8Array(data)
  };
}

async function encodePngToFile(image: IpcPixelImage, filePath: string): Promise<void> {
  await sharp(Buffer.from(image.data), {
    raw: {
      width: image.width,
      height: image.height,
      channels: 4
    }
  })
    .png()
    .toFile(filePath);
}

function ensurePngName(name: string): string {
  return name.toLowerCase().endsWith(".png") ? name : `${name}.png`;
}

function ensureProjectName(name: string): string {
  return name.toLowerCase().endsWith(".dr") ? name : `${name}.dr`;
}
