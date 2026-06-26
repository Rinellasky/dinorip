import type { IpcPixelImage } from "@dinorip/ipc-contracts";
import { cloneImage, imageFromRgba } from "@dinorip/core";
import type { PixelImage } from "@dinorip/core";

interface PixelImageToCanvasOptions {
  maxSize?: number;
}

export type PixelImageSource = HTMLCanvasElement | ImageBitmap;

type PreviewWorkerResponse =
  | { id: string; ok: true; result: PixelImage }
  | { id: string; ok: false; error: string };

const PREVIEW_WORKER_PIXEL_THRESHOLD = 300_000;

let previewWorker: Worker | null = null;
let previewJobId = 0;
const previewJobs = new Map<string, { resolve: (value: PixelImage) => void; reject: (reason: Error) => void }>();

export function pixelImageToCanvas(image: PixelImage, options: PixelImageToCanvasOptions = {}): HTMLCanvasElement {
  const maxSize = options.maxSize ?? Infinity;
  if (Number.isFinite(maxSize) && Math.max(image.width, image.height) > maxSize) {
    return pixelImageToDownsampledCanvas(image, Math.max(1, Math.round(maxSize)));
  }

  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is unavailable.");
  // putImageData only reads the buffer, so back the ImageData with the image's
  // own data instead of copying it (the buffer is never mutated in place). The
  // cast satisfies lib.dom's non-shared ArrayBuffer requirement; our PixelImage
  // buffers are always plain ArrayBuffer-backed.
  const imageData = new ImageData(image.data as Uint8ClampedArray<ArrayBuffer>, image.width, image.height);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export async function pixelImageToImageSource(
  image: PixelImage,
  options: PixelImageToCanvasOptions = {}
): Promise<PixelImageSource> {
  const { width, height } = scaledImageSize(image, options.maxSize);
  if ((width !== image.width || height !== image.height) && image.width * image.height > PREVIEW_WORKER_PIXEL_THRESHOLD) {
    try {
      const preview = await runPreviewWorker(image, Math.max(width, height));
      return await pixelImageToImageSource(preview);
    } catch {
      // Fall through to browser/canvas resizing if the worker is unavailable.
    }
  }

  if (typeof createImageBitmap === "function") {
    try {
      const imageData = new ImageData(image.data as Uint8ClampedArray<ArrayBuffer>, image.width, image.height);
      if (width !== image.width || height !== image.height) {
        return await createImageBitmap(imageData, {
          resizeWidth: width,
          resizeHeight: height,
          resizeQuality: "low"
        });
      }
      return await createImageBitmap(imageData);
    } catch {
      // Fall through to the canvas path for older/limited browser contexts.
    }
  }
  if (width !== image.width || height !== image.height) {
    return pixelImageToScaledCanvas(image, width, height);
  }
  return pixelImageToCanvas(image, options);
}

function runPreviewWorker(image: PixelImage, maxSize: number): Promise<PixelImage> {
  const worker = getPreviewWorker();
  const id = `preview-${++previewJobId}`;
  const promise = new Promise<PixelImage>((resolve, reject) => {
    previewJobs.set(id, { resolve, reject });
  });
  worker.postMessage({ id, type: "preview", image, maxSize });
  return promise;
}

function getPreviewWorker(): Worker {
  if (previewWorker) return previewWorker;
  const worker = new Worker(new URL("../workers/processing.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<PreviewWorkerResponse>) => {
    const response = event.data;
    const pending = previewJobs.get(response.id);
    if (!pending) return;
    previewJobs.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error));
  };
  previewWorker = worker;
  return worker;
}

export function disposePixelImageSource(source: PixelImageSource | null | undefined): void {
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) source.close();
}

function scaledImageSize(image: PixelImage, maxSize = Infinity): { width: number; height: number } {
  if (!Number.isFinite(maxSize) || Math.max(image.width, image.height) <= maxSize) {
    return { width: image.width, height: image.height };
  }
  const scale = Math.max(1, Math.round(maxSize)) / Math.max(image.width, image.height);
  return {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale))
  };
}

function pixelImageToDownsampledCanvas(image: PixelImage, maxSize: number): HTMLCanvasElement {
  const scale = maxSize / Math.max(image.width, image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const srcY = Math.min(image.height - 1, Math.floor(((y + 0.5) / height) * image.height));
    for (let x = 0; x < width; x += 1) {
      const srcX = Math.min(image.width - 1, Math.floor(((x + 0.5) / width) * image.width));
      const src = (srcY * image.width + srcX) * 4;
      const dst = (y * width + x) * 4;
      data[dst] = image.data[src] ?? 0;
      data[dst + 1] = image.data[src + 1] ?? 0;
      data[dst + 2] = image.data[src + 2] ?? 0;
      data[dst + 3] = image.data[src + 3] ?? 0;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is unavailable.");
  ctx.putImageData(new ImageData(data, width, height), 0, 0);
  return canvas;
}

function pixelImageToScaledCanvas(image: PixelImage, width: number, height: number): HTMLCanvasElement {
  const source = pixelImageToCanvas(image);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is unavailable.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "low";
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

export async function pixelImageFromBlob(blob: Blob): Promise<PixelImage> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas is unavailable.");
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return imageFromRgba(bitmap.width, bitmap.height, imageData.data);
  } finally {
    bitmap.close();
  }
}

export function fromIpcImage(image: IpcPixelImage): PixelImage {
  return imageFromRgba(image.width, image.height, image.data);
}

export function toIpcImage(image: PixelImage): IpcPixelImage {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8Array(image.data)
  };
}

export function cloneForState(image: PixelImage): PixelImage {
  return cloneImage(image);
}
