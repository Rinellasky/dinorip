import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { defaultTextureAdjustments } from "@dinorip/core";
import type { PixelImage, Vec2 } from "@dinorip/core";
import type { TextureSettings } from "../renderer/types";
import {
  disposePixelImageSource,
  pixelImageToImageSource,
  type PixelImageSource
} from "../renderer/imageCanvas";
import { recordTexturePreviewBuild, recordTexturePreviewJob } from "../renderer/perf";

interface TexturePreviewProps {
  // The unedited source texture; adjustments are applied on top so the preview
  // is never cumulative.
  image: PixelImage;
  settings: TextureSettings;
  // Bumps when the underlying texture is re-extracted or resized.
  version: number;
  computeAdjusted(image: PixelImage, settings: TextureSettings): Promise<PixelImage>;
}

// Hold off recomputing while a slider is still being dragged.
const PREVIEW_DEBOUNCE_MS = 90;
const PREVIEW_MAX_SIZE = 768;
const PREVIEW_PIXEL_LIMIT = 300_000;
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.15;

// Single-image live preview of the selected texture with the adjustments
// applied. No tiling or seam logic — just the texture as an image, fit to the
// box, with optional scroll-zoom and drag-pan to inspect detail.
export function TexturePreview({ image, settings, version, computeAdjusted }: TexturePreviewProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The image actually painted: the raw texture at first, replaced by the
  // adjusted result once the (debounced) worker job returns.
  const sourceCanvas = useRef<PixelImageSource | null>(null);
  const drawnImage = useRef<PixelImage | null>(null);
  const drawnVersion = useRef<number | null>(null);
  const sourceKey = useRef("");
  const zoom = useRef(1);
  const offset = useRef<Vec2>({ x: 0, y: 0 });
  const panning = useRef<Vec2 | null>(null);
  // Latest-wins guard: an in-flight worker job whose id no longer matches the
  // current request is discarded so a slow result never overwrites a newer one.
  const requestId = useRef(0);
  const [, forceRedraw] = useState(0);

  const settingsKey = useMemo(() => JSON.stringify(settings), [settings]);

  // Recompute the adjusted preview whenever the texture or its settings change.
  useEffect(() => {
    const runId = requestId.current + 1;
    requestId.current = runId;
    const timers: number[] = [];
    let cancelled = false;
    let rawQueued = false;
    const rawKey = `raw:${version}`;

    const setPreviewSource = (key: string, source: PixelImageSource) => {
      if (cancelled || requestId.current !== runId) {
        disposePixelImageSource(source);
        return;
      }
      disposePixelImageSource(sourceCanvas.current);
      sourceCanvas.current = source;
      sourceKey.current = key;
      drawPreview(canvasRef.current, sourceCanvas.current, zoom.current, offset.current);
    };

    const queuePreviewBuild = (sourceImage: PixelImage, key: string, delayMs = 0) => {
      const timer = window.setTimeout(() => {
        const started = performance.now();
        void pixelImageToImageSource(sourceImage, { maxSize: PREVIEW_MAX_SIZE })
          .then((source) => {
            recordTexturePreviewBuild(performance.now() - started);
            setPreviewSource(key, source);
          })
          .catch(() => {
            // Leave the last good frame showing if preview source creation fails.
          });
      }, delayMs);
      timers.push(timer);
    };

    if (image.width * image.height > PREVIEW_PIXEL_LIMIT) {
      drawnImage.current = image;
      drawnVersion.current = version;
      zoom.current = 1;
      offset.current = { x: 0, y: 0 };
      disposePixelImageSource(sourceCanvas.current);
      sourceCanvas.current = null;
      sourceKey.current = `skipped:${version}`;
      drawPreview(canvasRef.current, sourceCanvas.current, zoom.current, offset.current);
      return () => {
        cancelled = true;
        timers.forEach((timer) => window.clearTimeout(timer));
      };
    }

    // On a texture swap, paint the raw texture immediately so selecting feels
    // instant (and reset the view); the actual bitmap is built asynchronously so
    // selecting a huge atlas texture cannot lock the main thread.
    if (drawnImage.current !== image || drawnVersion.current !== version) {
      drawnImage.current = image;
      drawnVersion.current = version;
      zoom.current = 1;
      offset.current = { x: 0, y: 0 };
      disposePixelImageSource(sourceCanvas.current);
      sourceCanvas.current = null;
      sourceKey.current = "";
      drawPreview(canvasRef.current, sourceCanvas.current, zoom.current, offset.current);
      queuePreviewBuild(image, rawKey);
      rawQueued = true;
    }

    if (settingsAreDefault(settings)) {
      if (sourceKey.current !== rawKey && !rawQueued) queuePreviewBuild(image, rawKey);
      return () => {
        cancelled = true;
        timers.forEach((timer) => window.clearTimeout(timer));
      };
    }

    const adjustedKey = `adjusted:${version}:${settingsKey}`;
    const timer = window.setTimeout(() => {
      const started = performance.now();
      void computeAdjusted(image, settings)
        .then((result) => {
          recordTexturePreviewJob(performance.now() - started);
          if (requestId.current !== runId) return;
          const buildStarted = performance.now();
          void pixelImageToImageSource(result, { maxSize: PREVIEW_MAX_SIZE })
            .then((source) => {
              recordTexturePreviewBuild(performance.now() - buildStarted);
              setPreviewSource(adjustedKey, source);
            })
            .catch(() => {
              // Leave the last good frame showing if preview source creation fails.
            });
        })
        .catch(() => {
          // Leave the last good frame showing if the adjustment fails.
        });
    }, PREVIEW_DEBOUNCE_MS);
    timers.push(timer);

    return () => {
      cancelled = true;
      timers.forEach((queuedTimer) => window.clearTimeout(queuedTimer));
    };
  }, [image, version, settingsKey, computeAdjusted]);

  useEffect(() => () => {
    disposePixelImageSource(sourceCanvas.current);
    sourceCanvas.current = null;
  }, []);

  // Redraw on container resizes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawPreview(canvas, sourceCanvas.current, zoom.current, offset.current);
    const observer = new ResizeObserver(() => drawPreview(canvas, sourceCanvas.current, zoom.current, offset.current));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const redraw = () => drawPreview(canvasRef.current, sourceCanvas.current, zoom.current, offset.current);

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    const next = clamp(zoom.current * factor, MIN_ZOOM, MAX_ZOOM);
    if (next === zoom.current) return;
    zoom.current = next;
    if (next === 1) offset.current = { x: 0, y: 0 };
    redraw();
    forceRedraw((n) => n + 1);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (zoom.current <= 1) return;
    if (event.button !== 0 && event.button !== 1) return;
    canvasRef.current?.setPointerCapture(event.pointerId);
    panning.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!panning.current) return;
    offset.current = {
      x: offset.current.x + event.clientX - panning.current.x,
      y: offset.current.y + event.clientY - panning.current.y
    };
    panning.current = { x: event.clientX, y: event.clientY };
    redraw();
  };

  const endPan = () => {
    panning.current = null;
  };

  return (
    <canvas
      ref={canvasRef}
      className="texture-preview"
      title="Scroll to zoom · drag to pan when zoomed"
      style={{ cursor: zoom.current > 1 ? "grab" : "default" }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onContextMenu={(event) => event.preventDefault()}
    />
  );
}

function settingsAreDefault(settings: TextureSettings): boolean {
  return Object.entries(defaultTextureAdjustments).every(([key, value]) =>
    settings[key as keyof TextureSettings] === value);
}

function drawPreview(
  canvas: HTMLCanvasElement | null,
  source: PixelImageSource | null,
  zoom: number,
  offset: Vec2
) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#2e2e2e";
  ctx.fillRect(0, 0, width, height);

  if (!source) return;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // "Contain" fit so the whole texture is visible at zoom 1, then scaled by the
  // zoom factor and translated by the pan offset, clamped so it can't be dragged
  // entirely off-screen.
  const fit = Math.min(width / source.width, height / source.height);
  const drawW = source.width * fit * zoom;
  const drawH = source.height * fit * zoom;
  const maxX = Math.max(0, (drawW - width) / 2);
  const maxY = Math.max(0, (drawH - height) / 2);
  const panX = clamp(offset.x, -maxX, maxX);
  const panY = clamp(offset.y, -maxY, maxY);
  const x = (width - drawW) / 2 + panX;
  const y = (height - drawH) / 2 + panY;
  ctx.drawImage(source, x, y, drawW, drawH);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
