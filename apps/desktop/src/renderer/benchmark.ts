export interface LagStats {
  maxLagMs: number;
  avgLagMs: number;
  samples: number;
}

export interface StressTimings {
  makeImageMs: number;
  pasteMs: number;
  pasteLag: LagStats;
  addRipperMs: number;
  cornerStretchMs: number;
  cornerStretchLag: LagStats;
  moveHugeRipperMs: number;
  moveHugeRipperLag: LagStats;
  selectAtlasMs: number;
  selectPointerDownMs: number;
  selectPointerUpMs: number;
  selectAtlasLag: LagStats;
}

export interface RipperStressOptions {
  sourceSize?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  settleMs?: number;
  cornerOvershootX?: number;
  cornerOvershootY?: number;
  stopAfter?: "load" | "add" | "corner" | "move" | "select";
}

export interface RipperStressResult {
  status: string;
  timings: Partial<StressTimings>;
  perf: ReturnType<NonNullable<typeof window.__dinoripPerf>["snapshot"]> | null;
}

export interface DinoripBenchmarkApi {
  stressRipper(options?: RipperStressOptions): Promise<RipperStressResult>;
  startStressRipper(options?: RipperStressOptions): string;
  getRun(id: string): BenchmarkRun | null;
}

export interface BenchmarkRun {
  id: string;
  state: "running" | "done" | "error";
  phase?: string;
  startedAt: number;
  updatedAt?: number;
  completedAt?: number;
  result?: RipperStressResult;
  error?: string;
}

const runs = new Map<string, BenchmarkRun>();
const FRAME_BUDGET_MS = 20;

export function installBenchmark(): void {
  window.__dinoripBenchmark = {
    stressRipper,
    startStressRipper,
    getRun
  };
}

function startStressRipper(options: RipperStressOptions = {}): string {
  const id = `stress-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  const run: BenchmarkRun = { id, state: "running", startedAt: performance.now() };
  runs.set(id, run);
  const setPhase = (phase: string) => {
    run.phase = phase;
    run.updatedAt = performance.now();
  };
  void stressRipper(options, setPhase)
    .then((result) => {
      run.state = "done";
      run.completedAt = performance.now();
      run.result = result;
    })
    .catch((error) => {
      run.state = "error";
      run.completedAt = performance.now();
      run.error = error instanceof Error ? error.message : String(error);
    });
  return id;
}

function getRun(id: string): BenchmarkRun | null {
  return runs.get(id) ?? null;
}

async function stressRipper(
  options: RipperStressOptions = {},
  setPhase: (phase: string) => void = () => {}
): Promise<RipperStressResult> {
  const sourceWidth = Math.max(1, Math.round(options.sourceWidth ?? options.sourceSize ?? 3072));
  const sourceHeight = Math.max(1, Math.round(options.sourceHeight ?? options.sourceSize ?? sourceWidth));
  const sourceMaxSize = Math.max(sourceWidth, sourceHeight);
  const settleMs = options.settleMs ?? 900;
  const overshootX = options.cornerOvershootX ?? 820;
  const overshootY = options.cornerOvershootY ?? 520;
  const timings: Partial<StressTimings> = {};

  window.__dinoripPerf?.reset();

  const devApi = window.__dinoripDev;
  if (!devApi) throw new Error("Benchmark source loader is not installed.");
  devApi.resetBenchmarkWorkspace();
  await wait(0);

  setPhase("make-image");
  const makeImageStart = performance.now();
  const image = await makeTestImage(sourceWidth, sourceHeight);
  timings.makeImageMs = Math.round(performance.now() - makeImageStart);

  setPhase("load-source");
  let monitor = startLagMonitor();
  const pasteStart = performance.now();
  devApi.loadBenchmarkSource(`ripper-stress-${sourceWidth}x${sourceHeight}`, image);
  await waitFor(() => /Benchmark loaded/.test(statusText()), 20_000);
  timings.pasteMs = Math.round(performance.now() - pasteStart);
  timings.pasteLag = monitor.stop();
  if (options.stopAfter === "load") return benchmarkResult(timings);

  setPhase("add-ripper");
  const addStart = performance.now();
  findButton("Add Ripper").click();
  await waitFor(() => {
    const perf = window.__dinoripPerf?.snapshot();
    return (perf?.syncExtractions ?? 0) > 0 || /Auto extracted|Extracted/.test(statusText());
  }, 15_000);
  await wait(150);
  timings.addRipperMs = Math.round(performance.now() - addStart);
  if (options.stopAfter === "add") return benchmarkResult(timings);

  setPhase("corner-stretch");
  const [source, atlas] = workspaces();
  const sourceRect = source.getBoundingClientRect();
  const zoom = Math.max(0.25, Math.min(1, 520 / sourceMaxSize));
  const cx = sourceRect.left + sourceRect.width / 2;
  const cy = sourceRect.top + sourceRect.height / 2;
  const corner = { x: cx + 50 * zoom, y: cy - 50 * zoom };
  const target = { x: sourceRect.right + overshootX, y: sourceRect.top - overshootY };

  const restorePointerCapture = stubPointerCapture();
  try {
    monitor = startLagMonitor();
    const stretchStart = performance.now();
    pointer(source, "pointerdown", corner.x, corner.y);
    for (let i = 1; i <= 18; i += 1) {
      const t = i / 18;
      pointer(source, "pointermove", lerp(corner.x, target.x, t), lerp(corner.y, target.y, t));
      await wait(8);
    }
    pointer(source, "pointerup", target.x, target.y, { buttons: 0 });
    await wait(settleMs);
    timings.cornerStretchMs = Math.round(performance.now() - stretchStart);
    timings.cornerStretchLag = monitor.stop();
    if (options.stopAfter === "corner") return benchmarkResult(timings);

    setPhase("move-ripper");
    const bodyStart = { x: cx + 35, y: cy - 10 };
    const bodyEnd = { x: bodyStart.x - 90, y: bodyStart.y + 65 };
    monitor = startLagMonitor();
    const moveStart = performance.now();
    pointer(source, "pointerdown", bodyStart.x, bodyStart.y);
    for (let i = 1; i <= 15; i += 1) {
      const t = i / 15;
      pointer(source, "pointermove", lerp(bodyStart.x, bodyEnd.x, t), lerp(bodyStart.y, bodyEnd.y, t));
      await wait(8);
    }
    pointer(source, "pointerup", bodyEnd.x, bodyEnd.y, { buttons: 0 });
    await wait(settleMs);
    timings.moveHugeRipperMs = Math.round(performance.now() - moveStart);
    timings.moveHugeRipperLag = monitor.stop();
    if (options.stopAfter === "move") return benchmarkResult(timings);

    setPhase("select-atlas");
    pointer(source, "pointerdown", cx, cy);
    pointer(source, "pointerup", cx, cy, { buttons: 0 });
    await wait(100);

    const atlasRect = atlas.getBoundingClientRect();
    const ax = atlasRect.left + atlasRect.width / 2;
    const ay = atlasRect.top + atlasRect.height / 2;
    monitor = startLagMonitor();
    const selectStart = performance.now();
    const selectDownStart = performance.now();
    pointer(atlas, "pointerdown", ax, ay);
    timings.selectPointerDownMs = Math.round(performance.now() - selectDownStart);
    const selectUpStart = performance.now();
    pointer(atlas, "pointerup", ax, ay, { buttons: 0 });
    timings.selectPointerUpMs = Math.round(performance.now() - selectUpStart);
    await wait(settleMs);
    timings.selectAtlasMs = Math.round(performance.now() - selectStart);
    timings.selectAtlasLag = monitor.stop();
  } finally {
    restorePointerCapture();
  }

  return benchmarkResult(timings);
}

function benchmarkResult(timings: Partial<StressTimings>): RipperStressResult {
  return {
    status: statusText(),
    timings,
    perf: window.__dinoripPerf?.snapshot() ?? null
  };
}

function startLagMonitor() {
  let last = performance.now();
  let max = 0;
  let sum = 0;
  let samples = 0;
  let active = true;
  let frame = 0;
  const tick = (now: number) => {
    if (!active) return;
    const gap = Math.max(0, now - last - FRAME_BUDGET_MS);
    max = Math.max(max, gap);
    sum += gap;
    samples += 1;
    last = now;
    frame = window.requestAnimationFrame(tick);
  };
  frame = window.requestAnimationFrame(tick);
  return {
    stop(): LagStats {
      active = false;
      window.cancelAnimationFrame(frame);
      return {
        maxLagMs: Math.round(max),
        avgLagMs: samples === 0 ? 0 : Math.round(sum / samples),
        samples
      };
    }
  };
}

async function makeTestImage(width: number, height: number): Promise<PixelImage> {
  const data = new Uint8ClampedArray(width * height * 4);
  const rowsPerChunk = Math.max(1, Math.floor(1_250_000 / (width * 4)));
  let y = 0;

  return new Promise((resolve) => {
    const fillChunk = () => {
      const endY = Math.min(height, y + rowsPerChunk);
      for (; y < endY; y += 1) {
        let offset = y * width * 4;
        for (let x = 0; x < width; x += 1) {
          const tile = ((Math.floor(x / 128) + Math.floor(y / 128)) % 2) * 38;
          const stripe = Math.abs((x - y) % 256) < 8 ? 255 : 0;
          const r = Math.max(stripe, Math.floor((x / width) * 220) + tile);
          const g = Math.max(stripe, Math.floor((y / height) * 220) + tile);
          const b = Math.max(stripe, Math.floor(((x / width + y / height) / 2) * 220) + tile);
          data[offset] = r;
          data[offset + 1] = g;
          data[offset + 2] = b;
          data[offset + 3] = 255;
          offset += 4;
        }
      }
      if (y < height) void yieldToTask().then(fillChunk);
      else resolve({ width, height, data });
    };
    fillChunk();
  });
}

function yieldToTask(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function pointer(
  canvas: HTMLCanvasElement,
  type: "pointerdown" | "pointermove" | "pointerup",
  x: number,
  y: number,
  init: { buttons?: number } = {}
): void {
  canvas.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 99,
    pointerType: "mouse",
    isPrimary: true,
    clientX: x,
    clientY: y,
    button: type === "pointermove" ? -1 : 0,
    buttons: init.buttons ?? (type === "pointerup" ? 0 : 1)
  }));
}

function stubPointerCapture(): () => void {
  const original = HTMLCanvasElement.prototype.setPointerCapture;
  HTMLCanvasElement.prototype.setPointerCapture = function (_pointerId: number) {};
  return () => {
    HTMLCanvasElement.prototype.setPointerCapture = original;
  };
}

function workspaces(): [HTMLCanvasElement, HTMLCanvasElement] {
  const canvases = document.querySelectorAll<HTMLCanvasElement>("canvas.workspace__canvas");
  const source = canvases[0];
  const atlas = canvases[1];
  if (!source || !atlas) throw new Error("Workspace canvases were not found.");
  return [source, atlas];
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((item) => item.textContent?.trim() === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

function statusText(): string {
  return document.querySelector(".app__status")?.textContent ?? "";
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (performance.now() - start >= timeoutMs) {
        reject(new Error("Timed out waiting for benchmark condition."));
        return;
      }
      void nextFrame().then(tick);
    };
    tick();
  });
}

async function wait(ms: number): Promise<void> {
  const end = performance.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      if (performance.now() >= end) {
        resolve();
        return;
      }
      void nextFrame().then(tick);
    };
    tick();
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
import type { PixelImage } from "@dinorip/core";
