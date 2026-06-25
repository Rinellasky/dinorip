import { describe, expect, it } from "vitest";
import {
  applyTextureAdjustments,
  colorNear,
  computeAtlasBounds,
  createRipper,
  cubicBezier,
  edgeControls,
  extractPerspective,
  findOwnerImageIndex,
  ripperSurfacePoint,
  shouldConserve,
  flipVertical,
  getPixel,
  imageFromRgba,
  inferExtractionSize,
  makeImage,
  makeSeamless,
  offsetWrap,
  opaque,
  pointInsidePolygon,
  rasterizeAtlas,
  sampleBilinear,
  snapAtlasItem,
  setPixel
} from "../src";
import type { Vec2 } from "../src";

describe("sampling", () => {
  it("bilinear samples y-up UVs from top-left row-major image data", () => {
    const image = makeImage(2, 2);
    setPixel(image, 0, 0, opaque(255, 0, 0));
    setPixel(image, 1, 0, opaque(0, 255, 0));
    setPixel(image, 0, 1, opaque(0, 0, 255));
    setPixel(image, 1, 1, opaque(255, 255, 255));

    expect(colorNear(sampleBilinear(image, 0, 1), opaque(255, 0, 0))).toBe(true);
    expect(colorNear(sampleBilinear(image, 1, 0), opaque(255, 255, 255))).toBe(true);
    expect(colorNear(sampleBilinear(image, 0.5, 0.5), { r: 128, g: 128, b: 128, a: 255 }, 1)).toBe(true);
  });

  it("flips vertically", () => {
    const image = imageFromRgba(1, 3, new Uint8ClampedArray([
      10, 0, 0, 255,
      20, 0, 0, 255,
      30, 0, 0, 255
    ]));

    const flipped = flipVertical(image);
    expect(getPixel(flipped, 0, 0).r).toBe(30);
    expect(getPixel(flipped, 0, 1).r).toBe(20);
    expect(getPixel(flipped, 0, 2).r).toBe(10);
  });
});

describe("perspective extraction", () => {
  it("infers output size and samples a quadrilateral over the owner image", () => {
    const source = makeImage(4, 4);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        setPixel(source, x, y, { r: x * 60, g: y * 60, b: 0, a: 255 });
      }
    }

    const ripper = createRipper({ x: 0, y: 0 }, 4);
    const result = extractPerspective(ripper, [{ image: source, position: { x: 0, y: 0 }, scale: { x: 1, y: 1 } }]);

    expect(result).not.toBeNull();
    expect(result?.image.width).toBe(16);
    expect(result?.image.height).toBe(16);
    expect(getPixel(result!.image, 0, 0).g).toBeLessThan(getPixel(result!.image, 0, 15).g);
    expect(getPixel(result!.image, 15, 0).r).toBeGreaterThan(getPixel(result!.image, 0, 0).r);
  });

  it("defaults each edge's controls to its 1/3 and 2/3 points (straight)", () => {
    const ripper = createRipper({ x: 0, y: 0 }, 6); // corners [tl, tr, br, bl]
    const [c1, c2] = edgeControls(ripper, 0); // top edge tl -> tr
    const tl = ripper.points[0];
    const tr = ripper.points[1];
    expect(c1.x).toBeCloseTo(tl.x + (tr.x - tl.x) / 3);
    expect(c2.x).toBeCloseTo(tl.x + (2 * (tr.x - tl.x)) / 3);
    expect(c1.y).toBeCloseTo(tl.y);
  });

  it("ripperSurfacePoint matches bilinear interpolation when all edges are straight", () => {
    const ripper = createRipper({ x: 0, y: 0 }, 10);
    const [tl, tr, br, bl] = ripper.points;
    for (const [u, v] of [[0.25, 0.75], [0.5, 0.5], [0.9, 0.1]] as const) {
      const top = { x: tl.x + (tr.x - tl.x) * u, y: tl.y + (tr.y - tl.y) * u };
      const bottom = { x: bl.x + (br.x - bl.x) * u, y: bl.y + (br.y - bl.y) * u };
      const expected = { x: bottom.x + (top.x - bottom.x) * v, y: bottom.y + (top.y - bottom.y) * v };
      const actual = ripperSurfacePoint(ripper, u, v);
      expect(actual.x).toBeCloseTo(expected.x);
      expect(actual.y).toBeCloseTo(expected.y);
    }
  });

  it("a curved edge bows the surface off the straight quad and follows the control", () => {
    const ripper = createRipper({ x: 0, y: 0 }, 10);
    const straightTopMid = ripperSurfacePoint(ripper, 0.5, 1); // on the top edge
    // Bow the top edge (tl -> tr) outward in +y via its two cubic controls.
    const [tl, tr] = ripper.points;
    ripper.edgeCurves = [
      [
        { x: tl.x + (tr.x - tl.x) / 3, y: tl.y + 6 },
        { x: tl.x + (2 * (tr.x - tl.x)) / 3, y: tl.y + 6 }
      ],
      null,
      null,
      null
    ];
    const curvedTopMid = ripperSurfacePoint(ripper, 0.5, 1);
    expect(curvedTopMid.y).toBeGreaterThan(straightTopMid.y);
    // The top edge at v=1 is exactly the cubic of edge 0, independent of the patch.
    const [c1, c2] = edgeControls(ripper, 0);
    const direct = cubicBezier(tl, c1, c2, tr, 0.5);
    expect(curvedTopMid.x).toBeCloseTo(direct.x);
    expect(curvedTopMid.y).toBeCloseTo(direct.y);
  });

  it("conserve mode masks pixels outside the curved outline (cutout), rectify fills them", () => {
    const owner = { image: makeImage(20, 20, opaque(200, 100, 50)), position: { x: 0, y: 0 }, scale: { x: 1, y: 1 } };
    // Diamond-ish ripper (corners at the cardinal points) with a mild outward
    // bulge on every edge, so its bounding-box corners fall outside the shape.
    const bulge = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const out = { x: mid.x * 1.2, y: mid.y * 1.2 };
      return [
        { x: a.x + (out.x - a.x) * 0.5, y: a.y + (out.y - a.y) * 0.5 },
        { x: b.x + (out.x - b.x) * 0.5, y: b.y + (out.y - b.y) * 0.5 }
      ] as const;
    };
    const pts = [
      { x: 0, y: 5 },
      { x: 5, y: 0 },
      { x: 0, y: -5 },
      { x: -5, y: 0 }
    ] as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
    const ripper = {
      points: pts,
      edgeCurves: [bulge(pts[0], pts[1]), bulge(pts[1], pts[2]), bulge(pts[2], pts[3]), bulge(pts[3], pts[0])],
      conserveShape: true
    };

    expect(shouldConserve(ripper)).toBe(true);
    const cut = extractPerspective(ripper, [owner]);
    expect(cut).not.toBeNull();
    const cx = Math.floor(cut!.image.width / 2);
    const cy = Math.floor(cut!.image.height / 2);
    expect(getPixel(cut!.image, 0, 0).a).toBe(0); // bbox corner: outside the curve
    expect(getPixel(cut!.image, cx, cy).a).toBe(255); // centre: inside the shape

    // Same ripper with conserve off rectifies: the corner pixel is now filled.
    const flat = extractPerspective({ ...ripper, conserveShape: false }, [owner]);
    expect(shouldConserve({ ...ripper, conserveShape: false })).toBe(false);
    expect(getPixel(flat!.image, 0, 0).a).toBe(255);
  });

  it("conserve mode preserves vertical orientation (top stays top)", () => {
    // Owner: top half red, bottom half green (row 0 is the top of the image).
    const img = makeImage(10, 10);
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 10; x += 1) {
        setPixel(img, x, y, y < 5 ? opaque(255, 0, 0) : opaque(0, 255, 0));
      }
    }
    const owner = { image: img, position: { x: 0, y: 0 }, scale: { x: 1, y: 1 } };
    // Square ripper (corners ±4) with a curve only on the left/right edges, so the
    // shape triggers conserve while the vertical extent stays the corners' ±4.
    const ripper = {
      points: [
        { x: -4, y: 4 },
        { x: 4, y: 4 },
        { x: 4, y: -4 },
        { x: -4, y: -4 }
      ] as [Vec2, Vec2, Vec2, Vec2],
      edgeCurves: [
        null,
        [{ x: 5, y: 2 }, { x: 5, y: -2 }] as const, // right edge bulges out in +x
        null,
        [{ x: -5, y: -2 }, { x: -5, y: 2 }] as const // left edge bulges out in -x
      ],
      conserveShape: true
    };
    const res = extractPerspective(ripper, [owner]);
    expect(res).not.toBeNull();
    const cx = Math.floor(res!.image.width / 2);
    const topPixel = getPixel(res!.image, cx, 0); // top row should sample the red top half
    const bottomPixel = getPixel(res!.image, cx, res!.image.height - 1); // bottom → green
    expect(topPixel.r).toBeGreaterThan(topPixel.g);
    expect(bottomPixel.g).toBeGreaterThan(bottomPixel.r);
  });

  it("selects the best owner image, including scaled and offset images", () => {
    const imageA = makeImage(20, 20, opaque(255, 0, 0));
    const imageB = makeImage(20, 20, opaque(0, 255, 0));
    const ripper = createRipper({ x: 100, y: 50 }, 20);

    const ownerIndex = findOwnerImageIndex(ripper, [
      { image: imageA, position: { x: 0, y: 0 }, scale: { x: 1, y: 1 } },
      { image: imageB, position: { x: 100, y: 50 }, scale: { x: 2, y: 2 } }
    ]);

    expect(ownerIndex).toBe(1);
  });

  it("matches shipped owner fallback when no corners are inside any image", () => {
    const image = makeImage(8, 8, opaque(255, 0, 0));
    const ripper = createRipper({ x: 1000, y: 1000 }, 20);
    expect(findOwnerImageIndex(ripper, [{ image, position: { x: 0, y: 0 }, scale: { x: 1, y: 1 } }])).toBe(0);
  });

  it("reports extraction size from average opposing edge lengths", () => {
    const size = inferExtractionSize({
      points: [
        { x: 0, y: 10 },
        { x: 30, y: 10 },
        { x: 20, y: -20 },
        { x: 0, y: -10 }
      ]
    });

    expect(size.width).toBe(26);
    expect(size.height).toBe(26);
  });

  it("uses point-in-polygon hit testing independent of winding", () => {
    const polygon = [
      { x: -10, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: -10 },
      { x: -10, y: -10 }
    ];
    expect(pointInsidePolygon({ x: 0, y: 0 }, polygon)).toBe(true);
    expect(pointInsidePolygon({ x: 20, y: 0 }, polygon)).toBe(false);
  });
});

describe("seamless generation", () => {
  it("offset wraps pixels by half width and height", () => {
    const image = imageFromRgba(2, 2, new Uint8ClampedArray([
      10, 0, 0, 255, 20, 0, 0, 255,
      30, 0, 0, 255, 40, 0, 0, 255
    ]));

    const shifted = offsetWrap(image, 1, 1);
    expect(getPixel(shifted, 0, 0).r).toBe(40);
    expect(getPixel(shifted, 1, 1).r).toBe(10);
  });

  it("smoothed collage blends center seams", () => {
    const image = makeImage(8, 8);
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        setPixel(image, x, y, opaque(x < 4 ? 20 : 220, y < 4 ? 30 : 230, 100));
      }
    }

    const seamless = makeSeamless(image, {
      method: "SmoothedCollage",
      blendWidth: 1,
      sampleRadius: 0,
      blurRadius: 1,
      restoreDetails: false,
      contrastBoost: 0
    });

    expect(getPixel(seamless, 4, 4).r).toBeGreaterThan(20);
    expect(getPixel(seamless, 4, 4).r).toBeLessThan(220);
  });

  it("scattered edges produces deterministic seam pixels", () => {
    const image = makeImage(8, 8, opaque(50, 100, 150));
    for (let y = 0; y < 8; y += 1) setPixel(image, 0, y, opaque(200, 20, 20));

    const a = makeSeamless(image, {
      method: "ScatteredEdges",
      blendWidth: 2,
      restoreDetails: false,
      contrastBoost: 0
    });
    const b = makeSeamless(image, {
      method: "ScatteredEdges",
      blendWidth: 2,
      restoreDetails: false,
      contrastBoost: 0
    });

    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(getPixel(a, 4, 4).r).toBe(50);
  });
});

describe("texture adjustments", () => {
  it("does not mutate the source and is a no-op with defaults", () => {
    const image = makeImage(4, 4, opaque(80, 120, 200));
    const result = applyTextureAdjustments(image, {});
    expect(getPixel(image, 1, 1)).toEqual({ r: 80, g: 120, b: 200, a: 255 });
    expect(getPixel(result, 1, 1)).toEqual({ r: 80, g: 120, b: 200, a: 255 });
    expect(result).not.toBe(image);
  });

  it("inverts and desaturates", () => {
    const image = makeImage(2, 2, opaque(10, 20, 30));
    expect(getPixel(applyTextureAdjustments(image, { invert: true }), 0, 0)).toEqual({ r: 245, g: 235, b: 225, a: 255 });

    const gray = applyTextureAdjustments(image, { grayscale: true });
    const g = getPixel(gray, 0, 0);
    expect(g.r).toBe(g.g);
    expect(g.g).toBe(g.b);
  });

  it("posterize snaps channels to the requested level count", () => {
    const image = makeImage(8, 1);
    for (let x = 0; x < 8; x += 1) setPixel(image, x, 0, opaque(x * 36, x * 36, x * 36));
    const result = applyTextureAdjustments(image, { posterizeLevels: 2 });
    // With 2 levels every channel collapses to either 0 or 255.
    for (let x = 0; x < 8; x += 1) {
      const v = getPixel(result, x, 0).r;
      expect(v === 0 || v === 255).toBe(true);
    }
  });
});

describe("atlas rasterization", () => {
  it("computes bounds and rasterizes placed images", () => {
    const red = makeImage(4, 4, opaque(255, 0, 0));
    const blue = makeImage(2, 2, opaque(0, 0, 255));
    const items = [
      { image: red, position: { x: 0, y: 0 }, scale: { x: 1, y: 1 } },
      { image: blue, position: { x: 4, y: 0 }, scale: { x: 1, y: 1 } }
    ];

    const bounds = computeAtlasBounds(items);
    const raster = rasterizeAtlas(items);

    expect(Math.ceil(bounds.width)).toBe(7);
    expect(Math.ceil(bounds.height)).toBe(4);
    expect(raster.image.width).toBe(7);
    expect(raster.image.height).toBe(4);
    expect(getPixel(raster.image, 0, 0).r).toBe(255);
    expect(getPixel(raster.image, 6, 1).b).toBe(255);
  });

  it("supports negative atlas scale and later items overwrite earlier items", () => {
    const gradient = makeImage(2, 2);
    setPixel(gradient, 0, 0, opaque(10, 0, 0));
    setPixel(gradient, 1, 0, opaque(20, 0, 0));
    setPixel(gradient, 0, 1, opaque(30, 0, 0));
    setPixel(gradient, 1, 1, opaque(40, 0, 0));
    const blue = makeImage(1, 1, opaque(0, 0, 255));

    const raster = rasterizeAtlas([
      { image: gradient, position: { x: 0, y: 0 }, scale: { x: -1, y: -1 } },
      { image: blue, position: { x: 0.5, y: 0.5 }, scale: { x: 1, y: 1 } }
    ]);

    expect(getPixel(raster.image, 0, 0).r).toBe(40);
    expect(getPixel(raster.image, 1, 0).b).toBe(255);
  });

  it("snaps atlas item edges to nearest neighbors", () => {
    const image = makeImage(10, 10, opaque(255, 255, 255));
    const selected = { image, position: { x: 12, y: 0 }, scale: { x: 1, y: 1 } };
    const neighbor = { image, position: { x: 0, y: 0 }, scale: { x: 1, y: 1 } };

    const snapped = snapAtlasItem(selected, [neighbor], 15);
    expect(snapped.x).toBe(10);
    expect(snapped.y).toBe(0);
  });
});
