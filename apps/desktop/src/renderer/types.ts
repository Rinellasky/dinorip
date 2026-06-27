import { defaultTextureAdjustments } from "@dinorip/core";
import type { PixelImage, TextureAdjustments, Vec2 } from "@dinorip/core";

export interface ViewState {
  zoom: number;
  pan: Vec2;
}

// The texture editor stores the core adjustment settings directly.
export type TextureSettings = TextureAdjustments;

export interface WorkspaceImageState {
  id: string;
  name: string;
  image: PixelImage;
  originalImage: PixelImage;
  position: Vec2;
  scale: Vec2;
  /** Rotation in radians, counter-clockwise in world space (atlas textures). */
  rotation: number;
  settings: TextureSettings;
  version: number;
}

export interface RipperState {
  id: string;
  /** Ordered polygon corners. Quads can rectify; other polygons extract as cutouts. */
  points: Vec2[];
  // Per-edge cubic Bézier controls (see PolygonRipper.edgeCurves in core). Edge
  // `i` runs from points[i] to points[(i+1)%points.length]; `null`/absent means a straight
  // edge. Kept structurally compatible with PolygonRipper so a RipperState is
  // passed straight through to the worker and GPU extraction.
  edgeCurves?: (readonly [Vec2, Vec2] | null)[];
  // Curved rippers extract as a shape-preserving cutout by default; this flag
  // (toggled via the atlas right-click menu) can switch back to rectification.
  // Ignored for straight rippers. See PolygonRipper.conserveShape in core.
  conserveShape?: boolean;
  outputImageId?: string;
}

export type WorkspaceKind = "source" | "atlas";

export const defaultViewState: ViewState = {
  zoom: 1,
  pan: { x: 0, y: 0 }
};

export const defaultTextureSettings: TextureSettings = { ...defaultTextureAdjustments };
