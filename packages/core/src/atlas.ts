import { makeImage, sampleBilinear, setPixel } from "./image";
import type { PixelImage, Rect, Vec2 } from "./image";

export interface AtlasItem {
  image: PixelImage;
  position: Vec2;
  scale: Vec2;
  /** Rotation in radians, counter-clockwise in world space. Defaults to 0. */
  rotation?: number;
}

// Cos/sin with right angles cleaned up: exact 90°/180°/270° rotations (easily
// reached via Shift-snapping) would otherwise carry ~1e-16 fuzz that rounds the
// atlas bounds up by a stray pixel. Snap values within epsilon of 0 and ±1.
function rotationTrig(angle: number): { cos: number; sin: number } {
  const snap = (value: number): number => {
    if (Math.abs(value) < 1e-9) return 0;
    if (Math.abs(value - 1) < 1e-9) return 1;
    if (Math.abs(value + 1) < 1e-9) return -1;
    return value;
  };
  return { cos: snap(Math.cos(angle)), sin: snap(Math.sin(angle)) };
}

// The four world-space corners of a placed item, accounting for rotation.
// Flips (negative scale) do not change the footprint, so magnitudes are used.
function itemCorners(item: AtlasItem): Vec2[] {
  const hw = (item.image.width * Math.abs(item.scale.x)) / 2;
  const hh = (item.image.height * Math.abs(item.scale.y)) / 2;
  const { cos, sin } = rotationTrig(item.rotation ?? 0);
  const locals: Vec2[] = [
    { x: -hw, y: hh },
    { x: hw, y: hh },
    { x: hw, y: -hh },
    { x: -hw, y: -hh }
  ];
  return locals.map((p) => ({
    x: item.position.x + p.x * cos - p.y * sin,
    y: item.position.y + p.x * sin + p.y * cos
  }));
}

export interface AtlasRasterResult {
  image: PixelImage;
  bounds: Rect;
}

export function computeAtlasBounds(items: AtlasItem[]): Rect {
  if (items.length === 0) {
    return { xMin: 0, yMin: 0, width: 1, height: 1 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const item of items) {
    for (const corner of itemCorners(item)) {
      minX = Math.min(minX, corner.x);
      maxX = Math.max(maxX, corner.x);
      minY = Math.min(minY, corner.y);
      maxY = Math.max(maxY, corner.y);
    }
  }

  return {
    xMin: minX,
    yMin: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

export function rasterizeAtlas(items: AtlasItem[]): AtlasRasterResult {
  const bounds = computeAtlasBounds(items);
  const atlasWidth = Math.max(1, Math.ceil(bounds.width));
  const atlasHeight = Math.max(1, Math.ceil(bounds.height));
  const output = makeImage(atlasWidth, atlasHeight);
  const yMax = bounds.yMin + bounds.height;

  for (const item of items) {
    const drawWidth = Math.max(1, Math.round(item.image.width * Math.abs(item.scale.x)));
    const drawHeight = Math.max(1, Math.round(item.image.height * Math.abs(item.scale.y)));

    if (item.rotation) {
      rasterizeRotatedItem(output, item, bounds, yMax, drawWidth, drawHeight);
      continue;
    }

    const left = Math.round(item.position.x - bounds.xMin - drawWidth / 2);
    const top = Math.round(yMax - (item.position.y + drawHeight / 2));
    const lastX = Math.max(1, drawWidth - 1);
    const lastY = Math.max(1, drawHeight - 1);

    for (let y = 0; y < drawHeight; y += 1) {
      const destY = top + y;
      if (destY < 0 || destY >= output.height) continue;
      let v = drawHeight === 1 ? 1 : 1 - y / lastY;
      if (item.scale.y < 0) v = 1 - v;

      for (let x = 0; x < drawWidth; x += 1) {
        const destX = left + x;
        if (destX < 0 || destX >= output.width) continue;
        let u = drawWidth === 1 ? 0 : x / lastX;
        if (item.scale.x < 0) u = 1 - u;
        setPixel(output, destX, destY, sampleBilinear(item.image, u, v));
      }
    }
  }

  return { image: output, bounds };
}

// Rasterize a rotated item by walking its axis-aligned bounding box in the
// atlas and, for each output pixel, inverse-rotating into the item's local
// frame to recover the (u, v) sample. Pixels outside the unit square are skipped
// so only the rotated quad is painted.
function rasterizeRotatedItem(
  output: PixelImage,
  item: AtlasItem,
  bounds: Rect,
  yMax: number,
  drawWidth: number,
  drawHeight: number
): void {
  const { cos, sin } = rotationTrig(item.rotation ?? 0);
  const flipU = item.scale.x < 0;
  const flipV = item.scale.y < 0;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const corner of itemCorners(item)) {
    minX = Math.min(minX, corner.x);
    maxX = Math.max(maxX, corner.x);
    minY = Math.min(minY, corner.y);
    maxY = Math.max(maxY, corner.y);
  }

  const startX = Math.max(0, Math.floor(minX - bounds.xMin));
  const endX = Math.min(output.width - 1, Math.ceil(maxX - bounds.xMin));
  const startY = Math.max(0, Math.floor(yMax - maxY));
  const endY = Math.min(output.height - 1, Math.ceil(yMax - minY));

  for (let destY = startY; destY <= endY; destY += 1) {
    const worldY = yMax - destY - 0.5;
    const dy = worldY - item.position.y;
    for (let destX = startX; destX <= endX; destX += 1) {
      const worldX = bounds.xMin + destX + 0.5;
      const dx = worldX - item.position.x;
      // Inverse rotation R(-angle) maps the world offset into the local frame.
      const localX = dx * cos + dy * sin;
      const localY = -dx * sin + dy * cos;
      let u = 0.5 + localX / drawWidth;
      let v = 0.5 + localY / drawHeight;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      if (flipU) u = 1 - u;
      if (flipV) v = 1 - v;
      setPixel(output, destX, destY, sampleBilinear(item.image, u, v));
    }
  }
}

// The axis-aligned footprint of a placed item, accounting for rotation/flips.
function itemFootprint(item: AtlasItem): { width: number; height: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const corner of itemCorners(item)) {
    minX = Math.min(minX, corner.x);
    maxX = Math.max(maxX, corner.x);
    minY = Math.min(minY, corner.y);
    maxY = Math.max(maxY, corner.y);
  }
  return { width: maxX - minX, height: maxY - minY };
}

export interface AtlasPackOptions {
  /** Gap left between neighbouring textures, in world px. Defaults to 0. */
  padding?: number;
}

// Arrange the items into a tight, roughly-square block and return the new centre
// position for each (same order as `items`); the items themselves are untouched.
// A shelf/row bin-packing: textures are sorted tallest-first and laid out left to
// right into rows no wider than a target derived from the total area, so rows
// stay balanced and little space is wasted. The packed block is centred on the
// world origin so it lands where the atlas view is looking.
export function packAtlasPositions(items: AtlasItem[], options: AtlasPackOptions = {}): Vec2[] {
  if (items.length === 0) return [];
  const padding = Math.max(0, options.padding ?? 0);

  const boxes = items.map((item, index) => {
    const footprint = itemFootprint(item);
    return { index, width: footprint.width, height: footprint.height };
  });

  // Target row width: the wider of the widest texture and the square-ish width
  // implied by the total (padded) area, so a single huge texture still fits.
  const totalArea = boxes.reduce((sum, box) => sum + (box.width + padding) * (box.height + padding), 0);
  const widest = boxes.reduce((max, box) => Math.max(max, box.width), 0);
  const targetWidth = Math.max(widest, Math.sqrt(totalArea));

  // Lay tallest-first so each row's height is set early and short textures fill
  // the remainder, which keeps rows from ending with tall ragged gaps.
  const order = [...boxes].sort((a, b) => b.height - a.height);
  const layout = new Array<{ x: number; y: number; width: number; height: number }>(items.length);
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  for (const box of order) {
    if (cursorX > 0 && cursorX + box.width > targetWidth) {
      cursorY += rowHeight + padding;
      cursorX = 0;
      rowHeight = 0;
    }
    layout[box.index] = { x: cursorX, y: cursorY, width: box.width, height: box.height };
    cursorX += box.width + padding;
    rowHeight = Math.max(rowHeight, box.height);
  }

  // Layout is top-left origin, y-down. Convert each slot to a world centre
  // (y-up), then recentre the whole block on the origin.
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const centers = layout.map((slot) => {
    const center = { x: slot.x + slot.width / 2, y: -(slot.y + slot.height / 2) };
    minX = Math.min(minX, center.x - slot.width / 2);
    maxX = Math.max(maxX, center.x + slot.width / 2);
    minY = Math.min(minY, center.y - slot.height / 2);
    maxY = Math.max(maxY, center.y + slot.height / 2);
    return center;
  });
  const offsetX = (minX + maxX) / 2;
  const offsetY = (minY + maxY) / 2;
  return centers.map((center) => ({ x: center.x - offsetX, y: center.y - offsetY }));
}

export function snapAtlasItem(selected: AtlasItem, neighbors: AtlasItem[], snapDistance: number): Vec2 {
  const selectedEdges = edgesOf(selected);
  const original = selected.position;
  let bestX = original.x;
  let bestY = original.y;
  let bestXDistance = Number.POSITIVE_INFINITY;
  let bestYDistance = Number.POSITIVE_INFINITY;

  const considerX = (a: number, b: number, target: number) => {
    const distance = Math.abs(a - b);
    if (distance <= snapDistance && distance < bestXDistance) {
      bestXDistance = distance;
      bestX = target;
    }
  };

  const considerY = (a: number, b: number, target: number) => {
    const distance = Math.abs(a - b);
    if (distance <= snapDistance && distance < bestYDistance) {
      bestYDistance = distance;
      bestY = target;
    }
  };

  for (const neighbor of neighbors) {
    if (neighbor === selected) continue;
    const e = edgesOf(neighbor);
    considerX(selectedEdges.left, e.right, original.x + (e.right - selectedEdges.left));
    considerX(selectedEdges.right, e.left, original.x + (e.left - selectedEdges.right));
    considerX(selectedEdges.left, e.left, original.x + (e.left - selectedEdges.left));
    considerX(selectedEdges.right, e.right, original.x + (e.right - selectedEdges.right));
    considerY(selectedEdges.top, e.bottom, original.y + (e.bottom - selectedEdges.top));
    considerY(selectedEdges.bottom, e.top, original.y + (e.top - selectedEdges.bottom));
    considerY(selectedEdges.top, e.top, original.y + (e.top - selectedEdges.top));
    considerY(selectedEdges.bottom, e.bottom, original.y + (e.bottom - selectedEdges.bottom));
  }

  return { x: bestX, y: bestY };
}

function edgesOf(item: AtlasItem): { left: number; right: number; top: number; bottom: number } {
  const width = item.image.width * Math.abs(item.scale.x);
  const height = item.image.height * Math.abs(item.scale.y);
  return {
    left: item.position.x - width / 2,
    right: item.position.x + width / 2,
    top: item.position.y + height / 2,
    bottom: item.position.y - height / 2
  };
}
