import {
  containsPoint,
  distance,
  makeImage,
  rectFromSize,
  sampleBilinear,
  setPixel
} from "./image";
import type { PixelImage, Vec2 } from "./image";

export const MIN_RIPPER_POINTS = 3;
export const RIPPER_OUTLINE_POINT_LIMIT = 64;

export interface PolygonRipper {
  // Ordered polygon corners in world space. Four-point rippers can be rectified;
  // any other point count is extracted as a shape-preserving cutout.
  points: Vec2[];
  // Optional per-edge cubic Bézier controls. Index `i` is the edge from
  // points[i] to points[(i+1)%points.length]; `[C1, C2]` are the two control points, or
  // `null` for a straight edge. When absent/null the edge is treated as a
  // straight line (controls at its 1/3 and 2/3 points), so the warp is
  // pixel-identical to a plain bilinear quad.
  edgeCurves?: (readonly [Vec2, Vec2] | null)[];
  // When the ripper has curved edges, "conserve" mode extracts the region as a
  // shape-preserving cutout (source pixels sampled in place, everything outside
  // the curved outline made transparent) instead of flattening the curve into a
  // rectangle. So a round wheel stays round rather than becoming a "sqheel".
  // Only meaningful for curved rippers; defaults to on for them (see
  // `shouldConserve`). Ignored for straight rippers (always rectified).
  conserveShape?: boolean;
}

export interface PlacedImage {
  image: PixelImage;
  position: Vec2;
  scale: Vec2;
}

export interface ExtractionResult {
  image: PixelImage;
  ownerIndex: number;
}

export function createRipper(center: Vec2, size = 100): PolygonRipper {
  const half = size / 2;
  return {
    points: [
      { x: center.x - half, y: center.y + half },
      { x: center.x + half, y: center.y + half },
      { x: center.x + half, y: center.y - half },
      { x: center.x - half, y: center.y - half }
    ]
  };
}

export function isQuadRipper(ripper: PolygonRipper): boolean {
  return ripper.points.length === 4;
}

function normalizeIndex(index: number, count: number): number {
  return ((index % count) + count) % count;
}

function lerpPoint(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function compactEdgeCurves(curves: (readonly [Vec2, Vec2] | null)[]): (readonly [Vec2, Vec2] | null)[] | undefined {
  return curves.some((curve) => curve != null) ? curves : undefined;
}

// The two cubic controls for edge `edgeIndex` (from points[i] to points[(i+1)%n]).
// Defaults to the 1/3 and 2/3 points, which makes the cubic exactly the straight
// segment — so an edge with no stored curve is pixel-identical to a linear edge.
export function edgeControls(ripper: PolygonRipper, edgeIndex: number): [Vec2, Vec2] {
  const count = ripper.points.length;
  const edge = normalizeIndex(edgeIndex, count);
  const p0 = ripper.points[edge]!;
  const p3 = ripper.points[(edge + 1) % count]!;
  const stored = ripper.edgeCurves?.[edge];
  if (stored) return [stored[0], stored[1]];
  return [
    { x: p0.x + (p3.x - p0.x) / 3, y: p0.y + (p3.y - p0.y) / 3 },
    { x: p0.x + (2 * (p3.x - p0.x)) / 3, y: p0.y + (2 * (p3.y - p0.y)) / 3 }
  ];
}

export function cubicBezier(p0: Vec2, c1: Vec2, c2: Vec2, p3: Vec2, t: number): Vec2 {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p3.y
  };
}

// A point on a four-point ripper's warped surface (Coons patch) at output coords
// (u, v), u left→right and v bottom→top (v = 1 is the top row). With all four
// edges straight this reduces exactly to the previous bilinear quad mapping.
export function ripperSurfacePoint(ripper: PolygonRipper, u: number, v: number): Vec2 {
  const [tl, tr, br, bl] = ripper.points;
  if (!isQuadRipper(ripper) || !tl || !tr || !br || !bl) {
    throw new Error("A rectified ripper surface requires exactly four points.");
  }
  const [t0, t1] = edgeControls(ripper, 0); // top: tl -> tr
  const [r0, r1] = edgeControls(ripper, 1); // right: tr -> br
  const [b0, b1] = edgeControls(ripper, 2); // bottom: br -> bl
  const [l0, l1] = edgeControls(ripper, 3); // left: bl -> tl

  const top = cubicBezier(tl, t0, t1, tr, u); // T(u)
  const bottom = cubicBezier(br, b0, b1, bl, 1 - u); // B(u): edge 2 reversed
  const left = cubicBezier(bl, l0, l1, tl, v); // L(v)
  const right = cubicBezier(tr, r0, r1, br, 1 - v); // R(v): edge 1 reversed

  const mu = 1 - u;
  const mv = 1 - v;
  const cx = mu * mv * bl.x + u * mv * br.x + mu * v * tl.x + u * v * tr.x;
  const cy = mu * mv * bl.y + u * mv * br.y + mu * v * tl.y + u * v * tr.y;

  return {
    x: mv * bottom.x + v * top.x + mu * left.x + u * right.x - cx,
    y: mv * bottom.y + v * top.y + mu * left.y + u * right.y - cy
  };
}

// True when at least one edge has an actual curve. Conserve mode only applies to
// curved rippers; a straight ripper is always rectified as before.
export function isRipperCurved(ripper: PolygonRipper): boolean {
  return ripper.edgeCurves?.some((curve) => curve != null) ?? false;
}

// Whether this ripper should be extracted as a shape-preserving cutout.
// Non-quad polygons always conserve, because there is no single quad surface to
// rectify through. Curved quads conserve by default; the flag can turn that off.
export function shouldConserve(ripper: PolygonRipper): boolean {
  if (!isQuadRipper(ripper)) return true;
  return isRipperCurved(ripper) && (ripper.conserveShape ?? true);
}

// Flatten the ripper boundary (its cubic edges) into a polygon. Shared by
// the CPU and GPU conserve paths and by hit-testing so they all agree.
export function ripperOutlineSegmentsPerEdge(pointCount: number, outlinePointLimit = RIPPER_OUTLINE_POINT_LIMIT): number {
  return Math.max(1, Math.floor(outlinePointLimit / Math.max(1, pointCount)));
}

export function ripperOutlinePoints(
  ripper: PolygonRipper,
  segmentsPerEdge = ripperOutlineSegmentsPerEdge(ripper.points.length)
): Vec2[] {
  const outline: Vec2[] = [];
  const count = ripper.points.length;
  const segments = Math.max(1, Math.round(segmentsPerEdge));
  for (let edge = 0; edge < count; edge += 1) {
    const p0 = ripper.points[edge]!;
    const p3 = ripper.points[(edge + 1) % count]!;
    if (!ripper.edgeCurves?.[edge]) {
      outline.push({ ...p0 });
      continue;
    }
    const [c1, c2] = edgeControls(ripper, edge);
    for (let step = 0; step < segments; step += 1) {
      outline.push(cubicBezier(p0, c1, c2, p3, step / segments));
    }
  }
  return outline;
}

// Parameter values in (0,1) where a 1D cubic Bézier reaches a local extremum
// (roots of its derivative). Used to bound a curve exactly instead of by samples.
function cubicExtrema1d(p0: number, c1: number, c2: number, p3: number): number[] {
  const a = -p0 + 3 * c1 - 3 * c2 + p3;
  const b = 2 * (p0 - 2 * c1 + c2);
  const c = c1 - p0;
  const epsilon = 1e-9;
  const roots: number[] = [];
  if (Math.abs(a) < epsilon) {
    if (Math.abs(b) >= epsilon) roots.push(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      roots.push((-b - root) / (2 * a), (-b + root) / (2 * a));
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}

// World-space axis-aligned bounds of the (possibly curved) ripper outline. Uses
// exact per-edge cubic extrema (not sampled points) so a strong bulge's apex is
// fully enclosed and the conserve-mode output is never clipped.
export function ripperBounds(ripper: PolygonRipper): { xMin: number; xMax: number; yMin: number; yMax: number } {
  if (ripper.points.length === 0) return { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  const include = (point: Vec2) => {
    if (point.x < xMin) xMin = point.x;
    if (point.x > xMax) xMax = point.x;
    if (point.y < yMin) yMin = point.y;
    if (point.y > yMax) yMax = point.y;
  };
  const count = ripper.points.length;
  for (let edge = 0; edge < count; edge += 1) {
    const p0 = ripper.points[edge]!;
    const p3 = ripper.points[(edge + 1) % count]!;
    const [c1, c2] = edgeControls(ripper, edge);
    const ts = [0, 1, ...cubicExtrema1d(p0.x, c1.x, c2.x, p3.x), ...cubicExtrema1d(p0.y, c1.y, c2.y, p3.y)];
    for (const t of ts) include(cubicBezier(p0, c1, c2, p3, t));
  }
  return { xMin, xMax, yMin, yMax };
}

export function inferExtractionSize(ripper: PolygonRipper): { width: number; height: number } {
  if (shouldConserve(ripper)) {
    // Cutout output spans the outline's bounding box (world units, matching the
    // rectify path's world-distance sizing).
    const { xMin, xMax, yMin, yMax } = ripperBounds(ripper);
    return {
      width: Math.max(16, Math.round(xMax - xMin)),
      height: Math.max(16, Math.round(yMax - yMin))
    };
  }
  const [topLeft, topRight, bottomRight, bottomLeft] = ripper.points;
  if (!topLeft || !topRight || !bottomRight || !bottomLeft) {
    const { xMin, xMax, yMin, yMax } = ripperBounds(ripper);
    return {
      width: Math.max(16, Math.round(xMax - xMin)),
      height: Math.max(16, Math.round(yMax - yMin))
    };
  }
  const topWidth = distance(topLeft, topRight);
  const bottomWidth = distance(bottomLeft, bottomRight);
  const leftHeight = distance(topLeft, bottomLeft);
  const rightHeight = distance(topRight, bottomRight);

  return {
    width: Math.max(16, Math.round((topWidth + bottomWidth) * 0.5)),
    height: Math.max(16, Math.round((leftHeight + rightHeight) * 0.5))
  };
}

export function extractPerspective(ripper: PolygonRipper, sourceImages: PlacedImage[]): ExtractionResult | null {
  const ownerIndex = findOwnerImageIndex(ripper, sourceImages);
  if (ownerIndex < 0) return null;

  const owner = sourceImages[ownerIndex];
  if (!owner) return null;

  const { width, height } = inferExtractionSize(ripper);
  const output = makeImage(width, height);
  const lastX = Math.max(1, width - 1);
  const lastY = Math.max(1, height - 1);
  const scaleX = owner.scale.x === 0 ? 1 : owner.scale.x;
  const scaleY = owner.scale.y === 0 ? 1 : owner.scale.y;

  if (shouldConserve(ripper)) {
    // Shape-preserving cutout: map the output rectangle 1:1 onto the outline's
    // world bounding box, sample the source in place, and zero alpha outside the
    // curved outline so the original shape is retained.
    const { xMin, xMax, yMin, yMax } = ripperBounds(ripper);
    const outline = ripperOutlinePoints(ripper);
    for (let y = 0; y < height; y += 1) {
      // Sample pixel centres ((y+0.5)/height), not edges: keeps the outermost
      // rows/cols off the bbox boundary (which the inside-test would otherwise
      // mask) and matches the GPU, which samples at fragment centres.
      const worldY = yMax - ((y + 0.5) / height) * (yMax - yMin); // row 0 = top (max y)
      for (let x = 0; x < width; x += 1) {
        const worldX = xMin + ((x + 0.5) / width) * (xMax - xMin);
        if (!pointInsidePolygon({ x: worldX, y: worldY }, outline)) continue; // transparent
        const localX = (worldX - owner.position.x) / scaleX;
        const localY = (worldY - owner.position.y) / scaleY;
        const srcU = localX / owner.image.width + 0.5;
        const srcV = localY / owner.image.height + 0.5;
        setPixel(output, x, y, sampleBilinear(owner.image, srcU, srcV));
      }
    }
    return { image: output, ownerIndex };
  }

  if (!isQuadRipper(ripper)) return null;

  for (let y = 0; y < height; y += 1) {
    const v = height === 1 ? 1 : 1 - y / lastY;
    for (let x = 0; x < width; x += 1) {
      const u = width === 1 ? 0 : x / lastX;
      const point = ripperSurfacePoint(ripper, u, v);
      const localX = (point.x - owner.position.x) / scaleX;
      const localY = (point.y - owner.position.y) / scaleY;
      const srcU = localX / owner.image.width + 0.5;
      const srcV = localY / owner.image.height + 0.5;
      setPixel(output, x, y, sampleBilinear(owner.image, srcU, srcV));
    }
  }

  return { image: output, ownerIndex };
}

export function insertRipperPoint<T extends PolygonRipper>(ripper: T, edgeIndex: number, t = 0.5): T {
  const count = ripper.points.length;
  if (count < MIN_RIPPER_POINTS) return ripper;
  const edge = normalizeIndex(edgeIndex, count);
  const p0 = ripper.points[edge]!;
  const p3 = ripper.points[(edge + 1) % count]!;
  const curve = ripper.edgeCurves?.[edge] ?? null;
  const points = ripper.points.map((point) => ({ ...point }));
  const edgeCurves = Array.from({ length: count }, (_, index) => ripper.edgeCurves?.[index] ?? null);

  if (curve) {
    const [c1, c2] = curve;
    const p01 = lerpPoint(p0, c1, t);
    const p12 = lerpPoint(c1, c2, t);
    const p23 = lerpPoint(c2, p3, t);
    const p012 = lerpPoint(p01, p12, t);
    const p123 = lerpPoint(p12, p23, t);
    const midpoint = lerpPoint(p012, p123, t);
    points.splice(edge + 1, 0, midpoint);
    edgeCurves.splice(edge, 1, [p01, p012] as const, [p123, p23] as const);
  } else {
    points.splice(edge + 1, 0, lerpPoint(p0, p3, t));
    edgeCurves.splice(edge, 1, null, null);
  }

  return { ...ripper, points, edgeCurves: compactEdgeCurves(edgeCurves) } as T;
}

export function deleteRipperPoint<T extends PolygonRipper>(ripper: T, pointIndex: number): T {
  const count = ripper.points.length;
  if (count <= MIN_RIPPER_POINTS) return ripper;
  const deleted = normalizeIndex(pointIndex, count);
  const oldIndices = ripper.points.map((_, index) => index).filter((index) => index !== deleted);
  const points = oldIndices.map((index) => ({ ...ripper.points[index]! }));
  const edgeCurves: (readonly [Vec2, Vec2] | null)[] = [];

  for (let edge = 0; edge < points.length; edge += 1) {
    const oldStart = oldIndices[edge]!;
    const oldEnd = oldIndices[(edge + 1) % points.length]!;
    edgeCurves[edge] = oldEnd === (oldStart + 1) % count ? ripper.edgeCurves?.[oldStart] ?? null : null;
  }

  return { ...ripper, points, edgeCurves: compactEdgeCurves(edgeCurves) } as T;
}

export function findOwnerImageIndex(ripper: PolygonRipper, sourceImages: PlacedImage[]): number {
  let bestIndex = -1;
  let bestInsideCount = -1;

  sourceImages.forEach((image, index) => {
    const rect = rectFromSize(image.image.width, image.image.height);
    const scaleX = image.scale.x === 0 ? 1 : image.scale.x;
    const scaleY = image.scale.y === 0 ? 1 : image.scale.y;
    const inside = ripper.points.reduce((count, point) => {
      const local = {
        x: (point.x - image.position.x) / scaleX,
        y: (point.y - image.position.y) / scaleY
      };
      return containsPoint(rect, local) ? count + 1 : count;
    }, 0);

    if (inside > bestInsideCount) {
      bestInsideCount = inside;
      bestIndex = index;
    }
  });

  return bestIndex;
}

export function pointInsidePolygon(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  let previous = polygon.length - 1;

  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    if (!a || !b) continue;

    const crossesY = (a.y > point.y) !== (b.y > point.y);
    if (crossesY) {
      const intersectionX = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (point.x < intersectionX) inside = !inside;
    }

    previous = index;
  }

  return inside;
}
