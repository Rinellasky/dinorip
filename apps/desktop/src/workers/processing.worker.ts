import {
  applyTextureAdjustments,
  extractPerspective,
  rasterizeAtlas
} from "@dinorip/core";
import type { AtlasItem, PixelImage, PlacedImage, PolygonRipper, TextureAdjustments } from "@dinorip/core";

type WorkerRequest =
  | { id: string; type: "extract"; ripper: PolygonRipper; images: PlacedImage[] }
  | { id: string; type: "adjust"; image: PixelImage; settings: TextureAdjustments }
  | { id: string; type: "atlas"; items: AtlasItem[] }
  | { id: string; type: "preview"; image: PixelImage; maxSize: number };

type WorkerPostTarget = {
  postMessage(message: unknown, transfer: Transferable[]): void;
};

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === "extract") {
      postOk(request.id, extractPerspective(request.ripper, request.images));
      return;
    }

    if (request.type === "adjust") {
      postOk(request.id, applyTextureAdjustments(request.image, request.settings));
      return;
    }

    if (request.type === "atlas") {
      postOk(request.id, rasterizeAtlas(request.items));
      return;
    }

    postOk(request.id, downsampleForPreview(request.image, request.maxSize));
  } catch (error) {
    self.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

function postOk(id: string, result: AtlasRasterResult | ExtractionResult | PixelImage | null): void {
  (self as unknown as WorkerPostTarget).postMessage(
    { id, ok: true, result },
    transferablesFor(result)
  );
}

type AtlasRasterResult = ReturnType<typeof rasterizeAtlas>;
type ExtractionResult = ReturnType<typeof extractPerspective>;

function downsampleForPreview(image: PixelImage, maxSize: number): PixelImage {
  const boundedMax = Math.max(1, Math.round(maxSize));
  const scale = Math.min(1, boundedMax / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  if (width === image.width && height === image.height) {
    return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  }

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

  return { width, height, data };
}

function transferablesFor(result: AtlasRasterResult | ExtractionResult | PixelImage | null): Transferable[] {
  if (!result) return [];
  if ("data" in result) return [result.data.buffer as Transferable];
  return [result.image.data.buffer as Transferable];
}
