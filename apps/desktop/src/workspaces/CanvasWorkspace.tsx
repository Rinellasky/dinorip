import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import {
  IMAGE_MIN_SCALE,
  SNAP_DISTANCE,
  VERTEX_HIT_RADIUS,
  VIEWPORT_MAX_ZOOM,
  VIEWPORT_MIN_ZOOM,
  VIEWPORT_ZOOM_SPEED
} from "@dinorip/ipc-contracts";
import { cubicBezier, edgeControls, pointInsidePolygon, ripperOutlinePoints, snapAtlasItem } from "@dinorip/core";
import type { AtlasItem, Vec2 } from "@dinorip/core";
import type { RipperState, ViewState, WorkspaceImageState, WorkspaceKind } from "../renderer/types";
import {
  disposePixelImageSource,
  pixelImageToImageSource,
  type PixelImageSource
} from "../renderer/imageCanvas";
import { recordWorkspaceRender } from "../renderer/perf";

export const WORKSPACE_RENDER_EVENT = "dinorip:render-workspaces";

export interface WorkspaceLivePreview {
  /** The atlas image id this preview stands in for. */
  imageId: string;
  /** GPU canvas holding the live projection; blitted directly with drawImage. */
  canvas: HTMLCanvasElement;
  /** Natural output dimensions used to size the on-screen rect. */
  width: number;
  height: number;
}

/** World-space rectangle (px) describing what the atlas would export. */
export interface ExportRegion {
  /** Left edge in world units. */
  xMin: number;
  /** Top edge in world units (largest y). */
  yMax: number;
  width: number;
  height: number;
}

interface CanvasWorkspaceProps {
  kind: WorkspaceKind;
  title: string;
  emptyLabel: string;
  showHeader?: boolean;
  /** Background fill style: a tiled checkerboard (default) or thin grid lines. */
  background?: "checker" | "grid";
  /** When set (atlas), draws a white outline showing the exported atlas size. */
  exportRegion?: ExportRegion | null;
  images: WorkspaceImageState[];
  rippers?: RipperState[];
  selectedImageId?: string;
  selectedImageIds?: string[];
  selectedRipperId?: string;
  selectedRipperIds?: string[];
  view: ViewState;
  // Mutable ref holding the live GPU projection to draw in place of a cached
  // image while a ripper is being dragged. Read every animation frame, so
  // updating its `.current` needs no React re-render.
  livePreview?: { readonly current: WorkspaceLivePreview | null };
  onLivePreviewCached?(imageId: string): void;
  onViewChange(view: ViewState): void;
  onSelectImage(id?: string): void;
  onSelectRipper?(id?: string): void;
  onSelectRippers?(ids: string[]): void;
  // Absolute world-space position the image's centre should move to. Atlas
  // snapping is resolved by the canvas before this is called.
  onMoveImage(id: string, position: Vec2): void;
  onMoveImages?(updates: Array<{ id: string; position: Vec2 }>): void;
  onScaleImage(id: string, nextScale: Vec2): void;
  onTransformImages?(updates: Array<{ id: string; position: Vec2; scale: Vec2 }>): void;
  /** Atlas only: set a texture's rotation (radians, CCW in world space). */
  onRotateImage?(id: string, rotation: number): void;
  onMoveRipper?(id: string, delta: Vec2): void;
  onMoveRippers?(ids: string[], delta: Vec2): void;
  onMoveVertex?(id: string, index: number, point: Vec2): void;
  /** Batched corner move — used for group drags and Cmd-uniform-scaling. */
  onMoveVertices?(updates: VertexUpdate[]): void;
  /** Insert a new corner after the given edge, usually at the edge midpoint. */
  onInsertVertex?(id: string, edge: number): void;
  /** Delete one corner. The app state enforces the minimum polygon size. */
  onDeleteVertex?(id: string, index: number): void;
  /** Set (or replace) one edge's cubic Bézier controls — curve create + handle drag. */
  onSetEdgeCurve?(id: string, edge: number, controls: readonly [Vec2, Vec2]): void;
  /** Clear one edge's curve (snap straight) — double-click a curve handle. */
  onRemoveEdgeCurve?(id: string, edge: number): void;
  /** Right-click on an image (atlas): reports the image under the cursor (or undefined). */
  onImageContextMenu?(id: string | undefined, clientX: number, clientY: number): void;
  onRipperEditStart?(id: string, editedIds?: string[]): void;
  onRipperEditEnd?(): void;
  onImageEditStart?(id: string): void;
  onImageEditEnd?(): void;
}

// A resize handle either drives a corner (both axes) or one edge (single axis).
type ResizeMode = "corner" | "edge-x" | "edge-y";

type VertexRef = { id: string; index: number };
type VertexUpdate = { id: string; index: number; point: Vec2 };

type DragState =
  | { type: "none" }
  // Pan is anchored to the moment the drag began: `startPointer` is the cursor
  // position and `startPan` the view offset at pointer-down. Each move derives an
  // absolute pan from these (pan = startPan + cursorDelta) instead of accumulating
  // off the live `view.pan`, which lags behind React's render cadence and makes
  // the background jitter when pointer events outpace commits.
  | { type: "pan"; startPointer: Vec2; startPan: Vec2 }
  // An image drag, anchored to pointer-down. `startWorld` is the cursor world
  // position and `startPos` the image centre at grab time; each move derives an
  // absolute target from these (target = startPos + cursorDelta) rather than
  // accumulating off the committed position. Accumulating broke snapping: once
  // an image snapped to a neighbour edge, the snapped position fed the next
  // frame and the image stuck to that edge until the cursor cleared the band in
  // a single frame. From a stable anchor the unsnapped target always tracks the
  // cursor, so snapping engages and releases cleanly.
  | { type: "image"; id: string; ids: string[]; startWorld: Vec2; startPositions: Record<string, Vec2> }
  // Resizing the selected atlas texture from a corner or edge handle. `anchor`
  // is the fixed point (opposite corner, or opposite edge midpoint) in world
  // space; `startScale` is the scale at grab time so a Shift-held proportional
  // resize can preserve the texture's aspect ratio.
  | { type: "resize"; id: string; ids: string[]; mode: ResizeMode; anchor: Vec2; startScale: Vec2; startImages: Record<string, { position: Vec2; scale: Vec2 }> }
  // Rotating the selected atlas texture around its centre via the stem handle.
  | { type: "rotate"; id: string; center: Vec2 }
  | { type: "ripper"; id: string; ids: string[]; lastWorld: Vec2 }
  // A corner drag. `startWorld`/`startPoints` snapshot the moment the drag began
  // so Cmd-scaling and group moves can be recomputed from a stable baseline
  // (letting Cmd be toggled mid-drag). `group` is every corner that moves with
  // this one (just the grabbed corner unless a multi-selection is active).
  | { type: "vertex"; id: string; index: number; startWorld: Vec2; startPoints: Record<string, Vec2[]>; startCurves?: (readonly [Vec2, Vec2] | null)[]; group: VertexRef[] }
  // Bending a straight edge into a curve: Cmd-drag from the edge. `p0`/`p3` are
  // the edge's endpoints (corners) captured at grab time; each move derives the
  // two cubic controls from a quadratic passing through the pointer.
  | { type: "createCurve"; id: string; edge: number; p0: Vec2; p3: Vec2 }
  // Dragging one of an edge's two cubic control handles. `other` is the sibling
  // control, held fixed; `which` is 0 (near edge start) or 1 (near edge end).
  | { type: "curveHandle"; id: string; edge: number; which: 0 | 1; other: Vec2 }
  // Rubber-band box that selects the ripper corners inside it on release.
  | { type: "marquee" };

const HANDLE_SCREEN_SIZE = 8;
const HANDLE_HIT_RADIUS = 9;
// Edge (midpoint) resize handles are a touch smaller and have their own pickup.
const EDGE_HANDLE_HIT_RADIUS = 8;
// The rotation handle floats this many screen px beyond the top edge midpoint.
const ROT_HANDLE_OFFSET = 22;
const ROT_HANDLE_RADIUS = 5;
const ROT_HANDLE_HIT_RADIUS = 9;
const VERTEX_HANDLE_SIZE = 7;
const VERTEX_HANDLE_SELECTED_SIZE = 10;
// Curve control handles are drawn as small circles, distinct from corner squares.
const CURVE_HANDLE_RADIUS = 5;
// Screen-space pickup distance (world = / zoom) for curve handles and edges.
const CURVE_HANDLE_HIT_PX = 9;
const EDGE_HIT_PX = 7;
const WORKSPACE_IMAGE_MAX_DISPLAY_SIZE = 768;

type CachedDisplaySource = {
  version: number;
  source: PixelImageSource | null;
  loading: boolean;
};

type MutableRef<T> = {
  current: T;
};

function useLazyRef<T>(factory: () => T): MutableRef<T> {
  const ref = useRef<T | null>(null);
  if (ref.current === null) ref.current = factory();
  return ref as MutableRef<T>;
}

export function CanvasWorkspace(props: CanvasWorkspaceProps): ReactElement {
  return useCanvasWorkspace(props);
}

function useCanvasWorkspace(props: CanvasWorkspaceProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState>({ type: "none" });
  const canvasCache = useLazyRef(() => new Map<string, CachedDisplaySource>());
  const canvasCacheMap = canvasCache.current;
  const renderNowRef = useRef<(time?: number) => void>(() => {});
  const rippers = props.rippers ?? [];
  // Multi-corner selection (keys are `${ripperId}#${index}`). Highlighted on the
  // canvas; dragging any member moves the whole set. Live marquee box is held in
  // a ref so dragging it does not re-render every frame.
  const selectedVerticesRef = useLazyRef(() => new Set<string>());
  const marqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const selectedImage = props.images.find((image) => image.id === props.selectedImageId);
  const selectedImageIds = props.selectedImageIds ?? (props.selectedImageId ? [props.selectedImageId] : []);
  const selectedRipperIds = props.selectedRipperIds ?? (props.selectedRipperId ? [props.selectedRipperId] : []);

  const setSelectedVertices = (next: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    selectedVerticesRef.current = typeof next === "function" ? next(selectedVerticesRef.current) : next;
    renderNowRef.current();
  };

  const renderNow = (time = performance.now()) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    syncCanvasSize(canvas);
    recordWorkspaceRender(props.kind);
    drawWorkspace(
      ctx,
      canvas,
      props,
      canvasCacheMap,
      time,
      selectedVerticesRef.current,
      marqueeRef.current,
      () => renderNowRef.current()
    );
  };
  renderNowRef.current = renderNow;

  useEffect(() => {
    renderNowRef.current();
  }, [props]);

  useEffect(() => {
    if (props.kind !== "source" || rippers.length === 0) return;
    let frame = 0;
    const tick = (time: number) => {
      renderNowRef.current(time);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [props.kind, rippers.length]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderNowRef.current();
    const observer = new ResizeObserver(() => renderNowRef.current());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onRenderRequest = () => renderNowRef.current();
    window.addEventListener(WORKSPACE_RENDER_EVENT, onRenderRequest);
    return () => window.removeEventListener(WORKSPACE_RENDER_EVENT, onRenderRequest);
  }, []);

  useEffect(() => {
    const liveIds = new Set(props.images.map((image) => image.id));
    for (const [id, cached] of canvasCacheMap) {
      if (liveIds.has(id)) continue;
      disposePixelImageSource(cached.source);
      canvasCacheMap.delete(id);
    }
  }, [canvasCacheMap, props.images]);

  useEffect(() => () => {
    for (const cached of canvasCacheMap.values()) disposePixelImageSource(cached.source);
    canvasCacheMap.clear();
  }, [canvasCacheMap]);

  const toWorld = (event: React.MouseEvent<HTMLCanvasElement> | React.WheelEvent<HTMLCanvasElement>): Vec2 => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return screenToWorld({ x, y }, canvas, props.view);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(event.pointerId);

    if (event.button === 1) {
      event.preventDefault();
      const world = toWorld(event);
      const vertexHit = hitVertex(world, rippers, props.view.zoom);
      if (vertexHit && props.onDeleteVertex && props.onSelectRipper) {
        props.onSelectRipper(vertexHit.ripper.id);
        if (selectedVerticesRef.current.size > 0) setSelectedVertices(new Set());
        props.onDeleteVertex(vertexHit.ripper.id, vertexHit.index);
        dragRef.current = { type: "none" };
        setCanvasCursor(canvas, "pointer");
        return;
      }

      const edgeHit = hitEdge(world, rippers, props.view.zoom, true);
      if (edgeHit && props.onInsertVertex && props.onSelectRipper) {
        props.onSelectRipper(edgeHit.ripper.id);
        if (selectedVerticesRef.current.size > 0) setSelectedVertices(new Set());
        props.onInsertVertex(edgeHit.ripper.id, edgeHit.edge);
        dragRef.current = { type: "none" };
        setCanvasCursor(canvas, "copy");
        return;
      }

      dragRef.current = { type: "pan", startPointer: { x: event.clientX, y: event.clientY }, startPan: props.view.pan };
      setCanvasCursor(canvas, "grabbing");
      return;
    }

    if (event.button !== 0) return;
    const world = toWorld(event);

    // Rotate / resize handles take priority over the image body so grabbing a
    // handle of the selected atlas texture transforms it instead of moving it.
    if (props.kind === "atlas" && selectedImage) {
      const rect = canvas.getBoundingClientRect();
      const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const control = hitImageControl(screen, selectedImage, canvas, props.view);
      if (control?.kind === "rotate") {
        dragRef.current = { type: "rotate", id: selectedImage.id, center: selectedImage.position };
        props.onImageEditStart?.(selectedImage.id);
        setCanvasCursor(canvas, "grabbing");
        return;
      }
      if (control && control.anchor && control.mode) {
        const ids = selectedImageIds.length > 1 && selectedImageIds.includes(selectedImage.id)
          ? selectedImageIds
          : [selectedImage.id];
        dragRef.current = {
          type: "resize",
          id: selectedImage.id,
          ids,
          mode: control.mode,
          anchor: control.anchor,
          startScale: { ...selectedImage.scale },
          startImages: snapshotImageStates(props.images, ids)
        };
        props.onImageEditStart?.(selectedImage.id);
        setCanvasCursor(canvas, control.cursor);
        return;
      }
    }

    const vertexHit = hitVertex(world, rippers, props.view.zoom);
    if (vertexHit && props.onMoveVertex && props.onSelectRipper) {
      const key = vertexKey(vertexHit.ripper.id, vertexHit.index);
      props.onSelectRipper(vertexHit.ripper.id);
      if (event.altKey && props.onDeleteVertex) {
        event.preventDefault();
        if (selectedVerticesRef.current.size > 0) setSelectedVertices(new Set());
        props.onDeleteVertex(vertexHit.ripper.id, vertexHit.index);
        dragRef.current = { type: "none" };
        setCanvasCursor(canvas, "pointer");
        return;
      }
      // Shift-click toggles a corner in the multi-selection without starting a
      // drag, so several corners can be gathered before moving them as a group.
      if (event.shiftKey) {
        setSelectedVertices((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        dragRef.current = { type: "none" };
        return;
      }
      // Grabbing a Shift-selected corner drags that explicit corner group.
      // Ripper multi-selection does not imply "same corner on every ripper".
      const selectedVertices = selectedVerticesRef.current;
      const inVertexSelection = selectedVertices.has(key) && selectedVertices.size > 1;
      const group = inVertexSelection
        ? vertexRefsFromKeys(selectedVertices)
        : [{ id: vertexHit.ripper.id, index: vertexHit.index }];
      if (!inVertexSelection && selectedVertices.size > 0) setSelectedVertices(new Set());
      dragRef.current = {
        type: "vertex",
        id: vertexHit.ripper.id,
        index: vertexHit.index,
        startWorld: world,
        startPoints: snapshotPoints(rippers, group, vertexHit.ripper.id),
        // Snapshot the dragged ripper's curve controls so Cmd-scaling transforms
        // them from a stable baseline alongside the corners.
        startCurves: vertexHit.ripper.edgeCurves?.map((curve) =>
          curve ? ([{ ...curve[0] }, { ...curve[1] }] as const) : null),
        group
      };
      props.onRipperEditStart?.(vertexHit.ripper.id, uniqueIds(group.map((item) => item.id)));
      setCanvasCursor(canvas, "pointer");
      return;
    }

    // Dragging an existing curve handle (the small circles on a curved edge).
    // No modifier needed; corners are hit-tested first so this never shadows them.
    const curveHit = hitCurveHandle(world, rippers, props.view.zoom, props.selectedRipperId);
    if (curveHit && props.onSetEdgeCurve && props.onSelectRipper) {
      props.onSelectRipper(curveHit.ripper.id);
      if (selectedVerticesRef.current.size > 0) setSelectedVertices(new Set());
      const controls = edgeControls(curveHit.ripper, curveHit.edge);
      dragRef.current = {
        type: "curveHandle",
        id: curveHit.ripper.id,
        edge: curveHit.edge,
        which: curveHit.which,
        other: controls[curveHit.which === 0 ? 1 : 0]
      };
      props.onRipperEditStart?.(curveHit.ripper.id, [curveHit.ripper.id]);
      setCanvasCursor(canvas, "pointer");
      return;
    }

    // Cmd/Ctrl over a straight edge bends it into a curve: create the control on
    // press and drag it. Curved edges are excluded (they already show handles).
    if ((event.metaKey || event.ctrlKey) && props.onSetEdgeCurve && props.onSelectRipper) {
      const edgeHit = hitEdge(world, rippers, props.view.zoom);
      if (edgeHit) {
        props.onSelectRipper(edgeHit.ripper.id);
        if (selectedVerticesRef.current.size > 0) setSelectedVertices(new Set());
        const p0 = edgeHit.ripper.points[edgeHit.edge]!;
        const p3 = edgeHit.ripper.points[(edgeHit.edge + 1) % edgeHit.ripper.points.length]!;
        dragRef.current = { type: "createCurve", id: edgeHit.ripper.id, edge: edgeHit.edge, p0, p3 };
        props.onRipperEditStart?.(edgeHit.ripper.id, [edgeHit.ripper.id]);
        props.onSetEdgeCurve(edgeHit.ripper.id, edgeHit.edge, quadraticToCubic(p0, p3, world));
        setCanvasCursor(canvas, "pointer");
        return;
      }
    }

    const ripperHit = hitRipper(world, rippers);
    if (ripperHit && props.onMoveRipper && props.onSelectRipper) {
      const groupIds = selectedRipperIds.length > 1 && selectedRipperIds.includes(ripperHit.id)
        ? selectedRipperIds
        : [ripperHit.id];
      if (groupIds.length === 1) props.onSelectRipper(ripperHit.id);
      if (selectedVerticesRef.current.size > 0) setSelectedVertices(new Set());
      dragRef.current = { type: "ripper", id: ripperHit.id, ids: groupIds, lastWorld: world };
      props.onRipperEditStart?.(ripperHit.id, groupIds);
      setCanvasCursor(canvas, "grabbing");
      return;
    }

    const imageHit = hitImage(world, props.images);
    if (imageHit) {
      const groupIds = selectedImageIds.length > 1 && selectedImageIds.includes(imageHit.id)
        ? selectedImageIds
        : [imageHit.id];
      if (groupIds.length === 1) props.onSelectImage(imageHit.id);
      const shouldDrag = props.kind === "atlas" || event.shiftKey;
      if (shouldDrag) {
        dragRef.current = {
          type: "image",
          id: imageHit.id,
          ids: groupIds,
          startWorld: world,
          startPositions: snapshotImagePositions(props.images, groupIds)
        };
        props.onImageEditStart?.(imageHit.id);
      } else {
        dragRef.current = { type: "none" };
      }
      setCanvasCursor(canvas, shouldDrag ? "grabbing" : "move");
      return;
    }

    // Shift-drag on empty canvas rubber-bands a selection box over ripper corners
    // instead of panning.
    if (event.shiftKey && props.onMoveVertex && rippers.length > 0) {
      const rect = canvas.getBoundingClientRect();
      const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      marqueeRef.current = { x0: screen.x, y0: screen.y, x1: screen.x, y1: screen.y };
      dragRef.current = { type: "marquee" };
      setCanvasCursor(canvas, "crosshair");
      return;
    }

    props.onSelectImage(undefined);
    props.onSelectRipper?.(undefined);
    if (selectedVerticesRef.current.size > 0) setSelectedVertices(new Set());
    dragRef.current = { type: "pan", startPointer: { x: event.clientX, y: event.clientY }, startPan: props.view.pan };
    setCanvasCursor(canvas, "grabbing");
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const drag = dragRef.current;

    if (drag.type === "pan") {
      // Absolute pan from the drag anchor — never read back the live `view.pan`,
      // which trails React's commits and would feed jitter back into the drag.
      props.onViewChange({
        ...props.view,
        pan: {
          x: drag.startPan.x + (event.clientX - drag.startPointer.x),
          y: drag.startPan.y + (event.clientY - drag.startPointer.y)
        }
      });
      return;
    }

    if (drag.type === "vertex") {
      const world = toWorld(event);
      const scaleMode = event.metaKey || event.ctrlKey;
      const updates = computeVertexUpdates(drag, world, scaleMode);
      if (props.onMoveVertices) props.onMoveVertices(updates);
      else if (props.onMoveVertex) for (const update of updates) props.onMoveVertex(update.id, update.index, update.point);
      // Cmd-scale the curve controls through the same transform so curved edges
      // stretch with the shape instead of staying put. (React batches these
      // setRippers calls with the corner update above into one render.)
      if (scaleMode && drag.startCurves && props.onSetEdgeCurve) {
        const start = drag.startPoints[drag.id];
        const transform = start && start.length === 4 ? scaleTransform(start, drag.index, world) : null;
        if (transform) {
          drag.startCurves.forEach((curve, edge) => {
            if (curve) props.onSetEdgeCurve!(drag.id, edge, [transform(curve[0]), transform(curve[1])]);
          });
        }
      }
      return;
    }

    if (drag.type === "createCurve" && props.onSetEdgeCurve) {
      props.onSetEdgeCurve(drag.id, drag.edge, quadraticToCubic(drag.p0, drag.p3, toWorld(event)));
      return;
    }

    if (drag.type === "curveHandle" && props.onSetEdgeCurve) {
      const world = toWorld(event);
      const controls: [Vec2, Vec2] = drag.which === 0 ? [world, drag.other] : [drag.other, world];
      props.onSetEdgeCurve(drag.id, drag.edge, controls);
      return;
    }

    if (drag.type === "marquee") {
      if (marqueeRef.current) {
        const rect = canvas.getBoundingClientRect();
        marqueeRef.current.x1 = event.clientX - rect.left;
        marqueeRef.current.y1 = event.clientY - rect.top;
        renderNowRef.current();
      }
      return;
    }

    if (drag.type === "ripper" && props.onMoveRipper) {
      const world = toWorld(event);
      const delta = { x: world.x - drag.lastWorld.x, y: world.y - drag.lastWorld.y };
      if (drag.ids.length > 1 && props.onMoveRippers) props.onMoveRippers(drag.ids, delta);
      else props.onMoveRipper(drag.id, delta);
      dragRef.current = { type: "ripper", id: drag.id, ids: drag.ids, lastWorld: world };
      return;
    }

    if (drag.type === "resize") {
      const image = props.images.find((item) => item.id === drag.id);
      // Shift locks the aspect ratio (proportional resize); free otherwise.
      if (image) {
        if (drag.ids.length > 1 && props.onTransformImages) {
          props.onTransformImages(resizeImageGroupToPointer(image, drag, toWorld(event), event.shiftKey));
        } else {
          const next = resizedImageToPointer(image, drag, toWorld(event), event.shiftKey);
          props.onScaleImage(image.id, next.scale);
          props.onMoveImage(image.id, next.position);
        }
      }
      return;
    }

    if (drag.type === "rotate" && props.onRotateImage) {
      const world = toWorld(event);
      // The stem handle points along the texture's local +y at rotation 0
      // (straight up), so subtract a quarter turn from the pointer angle.
      let rotation = Math.atan2(world.y - drag.center.y, world.x - drag.center.x) - Math.PI / 2;
      // Shift snaps to 45° increments.
      if (event.shiftKey) rotation = Math.round(rotation / (Math.PI / 4)) * (Math.PI / 4);
      props.onRotateImage(drag.id, rotation);
      return;
    }

    if (drag.type === "image") {
      const world = toWorld(event);
      const delta = { x: world.x - drag.startWorld.x, y: world.y - drag.startWorld.y };
      if (drag.ids.length > 1 && props.onMoveImages) {
        props.onMoveImages(drag.ids.map((id) => {
          const start = drag.startPositions[id] ?? { x: 0, y: 0 };
          return { id, position: { x: start.x + delta.x, y: start.y + delta.y } };
        }));
        return;
      }
      const start = drag.startPositions[drag.id];
      if (!start) return;
      // Absolute target from the grab anchor, so the image follows the cursor
      // 1:1 regardless of any snapping applied on previous frames.
      const target = {
        x: start.x + delta.x,
        y: start.y + delta.y
      };
      const next = props.kind === "atlas"
        ? snapImageToNeighbors(drag.id, target, props.images, props.view.zoom)
        : target;
      props.onMoveImage(drag.id, next);
      return;
    }

    if (props.kind === "atlas" && selectedImage) {
      const rect = canvas.getBoundingClientRect();
      const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const control = hitImageControl(screen, selectedImage, canvas, props.view);
      if (control) {
        setCanvasCursor(canvas, control.cursor);
        return;
      }
    }

    updateHoverCursor(canvas, toWorld(event), props.images, rippers, props.view.zoom, props.kind, event.metaKey || event.ctrlKey, props.selectedRipperId);
  };

  const onContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    if (!props.onImageContextMenu) return;
    const hit = hitImage(toWorld(event), props.images);
    props.onImageContextMenu(hit?.id, event.clientX, event.clientY);
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!props.onRemoveEdgeCurve) return;
    const world = toWorld(event);
    const curveHit = hitCurveHandle(world, rippers, props.view.zoom, props.selectedRipperId);
    if (curveHit) {
      props.onRemoveEdgeCurve(curveHit.ripper.id, curveHit.edge);
      dragRef.current = { type: "none" };
    }
  };

  const endDrag = () => {
    const drag = dragRef.current;
    const canvas = canvasRef.current;

    if (drag.type === "marquee") {
      const box = marqueeRef.current;
      marqueeRef.current = null;
      dragRef.current = { type: "none" };
      setSelectedVertices(box ? pickVerticesInBox(box, rippers, canvas, props.view) : new Set());
      if (canvas) setCanvasCursor(canvas, "grab");
      return;
    }

    const wasEditingRipper =
      drag.type === "vertex" || drag.type === "ripper" || drag.type === "createCurve" || drag.type === "curveHandle";
    const wasEditingImage = drag.type === "image" || drag.type === "resize" || drag.type === "rotate";
    dragRef.current = { type: "none" };
    if (canvas) setCanvasCursor(canvas, "grab");
    if (wasEditingRipper) props.onRipperEditEnd?.();
    if (wasEditingImage) props.onImageEditEnd?.();
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    // The wheel always zooms the viewport (anchored at the cursor) so every
    // item scales together and nothing drifts relative to anything else.
    // Resizing a single image is done with the corner handles / side panel,
    // never the wheel — doing it here desynced the ripper from its image.
    const world = toWorld(event);

    const rect = canvas.getBoundingClientRect();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const direction = event.deltaY < 0 ? 1 : -1;
    const nextZoom = clamp(props.view.zoom + direction * VIEWPORT_ZOOM_SPEED, VIEWPORT_MIN_ZOOM, VIEWPORT_MAX_ZOOM);
    props.onViewChange({
      zoom: nextZoom,
      pan: {
        x: screen.x - canvas.clientWidth / 2 - world.x * nextZoom,
        y: screen.y - canvas.clientHeight / 2 + world.y * nextZoom
      }
    });
  };

  return (
    <section className={`workspace${props.showHeader === false ? " workspace--no-header" : ""}`}>
      {props.showHeader !== false && (
        <div className="workspace__header">
          <h2>{props.title}</h2>
          <span>{Math.round(props.view.zoom * 100)}%</span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="workspace__canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onAuxClick={(event) => event.preventDefault()}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onContextMenu={onContextMenu}
      />
    </section>
  );
}

function drawWorkspace(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  props: CanvasWorkspaceProps,
  cache: Map<string, CachedDisplaySource>,
  time: number,
  selectedVertices: Set<string>,
  marquee: { x0: number; y0: number; x1: number; y1: number } | null,
  onCacheReady: () => void
) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#363a38";
  ctx.fillRect(0, 0, width, height);
  if (props.background === "grid") {
    drawGridLines(ctx, width, height, props.view);
  } else {
    drawCheckerboard(ctx, width, height, props.view);
  }

  const live = props.livePreview?.current ?? null;
  const viewZoom = props.view.zoom;
  const selectedImageIds = props.selectedImageIds ?? (props.selectedImageId ? [props.selectedImageId] : []);
  const selectedImageIdSet = new Set(selectedImageIds);
  const selectedRipperIds = props.selectedRipperIds ?? (props.selectedRipperId ? [props.selectedRipperId] : []);
  const selectedRipperIdSet = new Set(selectedRipperIds);
  for (const image of props.images) {
    const usingLive = live !== null && live.imageId === image.id;
    const cached = cachedImageSource(image, cache, () => {
      if (props.livePreview?.current?.imageId === image.id) props.onLivePreviewCached?.(image.id);
      onCacheReady();
    });
    const imagePixels = image.image;
    const bitmap = usingLive ? live.canvas : cached?.source ?? null;
    const pixelWidth = usingLive ? live.width : imagePixels.width;
    const pixelHeight = usingLive ? live.height : imagePixels.height;
    // Draw the texture centred on its world position, rotating the canvas about
    // that centre. Flips are applied as a sign scale so the drawn size stays
    // positive; at rotation 0 with no flip this matches the old top-left blit.
    const center = worldToScreen(image.position, canvas, props.view);
    const width = pixelWidth * Math.abs(image.scale.x) * viewZoom;
    const height = pixelHeight * Math.abs(image.scale.y) * viewZoom;
    ctx.save();
    ctx.imageSmoothingEnabled = viewZoom <= 1;
    ctx.translate(center.x, center.y);
    // World rotation is CCW; screen y is flipped, so negate it for the canvas.
    if (image.rotation) ctx.rotate(-image.rotation);
    ctx.scale(Math.sign(image.scale.x) || 1, Math.sign(image.scale.y) || 1);
    if (bitmap) {
      ctx.drawImage(bitmap, -width / 2, -height / 2, width, height);
    } else {
      drawImageLoadingPlaceholder(ctx, -width / 2, -height / 2, width, height);
    }
    if (selectedImageIdSet.has(image.id)) {
      ctx.strokeStyle = "#2f7d6d";
      ctx.lineWidth = 2;
      ctx.strokeRect(-width / 2, -height / 2, width, height);
    }
    ctx.restore();
  }

  if (props.rippers) {
    for (const ripper of props.rippers) {
      drawRipper(ctx, canvas, props.view, ripper, selectedRipperIdSet.has(ripper.id), time, selectedVertices);
    }
  }

  if (marquee) drawMarquee(ctx, marquee);

  if (props.exportRegion && props.images.length > 0) {
    drawExportRegion(ctx, canvas, props.view, props.exportRegion);
  }

  if (props.kind === "atlas" && props.selectedImageId) {
    const selected = props.images.find((image) => image.id === props.selectedImageId);
    if (selected) drawImageHandles(ctx, canvas, props.view, selected);
  }

  if (props.images.length === 0 && (!props.rippers || props.rippers.length === 0)) {
    ctx.save();
    ctx.fillStyle = "rgba(219, 214, 197, 0.62)";
    ctx.font = '10px "Press Start 2P", ui-monospace, monospace';
    ctx.textAlign = "center";
    ctx.fillText(props.emptyLabel, width / 2, height / 2);
    ctx.restore();
  }
}

function drawCheckerboard(ctx: CanvasRenderingContext2D, width: number, height: number, view: ViewState) {
  const cell = Math.max(18, Math.round(42 * view.zoom));
  // Floor the tile origin to whole pixels so cell edges land on device pixels;
  // fractional fillRect coordinates leave anti-aliased seams that shimmer as the
  // canvas pans, breaking the seamless "infinite background" illusion.
  const startX = Math.floor((((width / 2 + view.pan.x) % cell) + cell) % cell - cell);
  const startY = Math.floor((((height / 2 + view.pan.y) % cell) + cell) % cell - cell);
  ctx.save();
  for (let y = startY; y < height + cell; y += cell) {
    for (let x = startX; x < width + cell; x += cell) {
      ctx.fillStyle = ((Math.floor((x - startX) / cell) + Math.floor((y - startY) / cell)) % 2 === 0)
        ? "rgba(75, 80, 77, 0.92)"
        : "rgba(54, 58, 55, 0.92)";
      ctx.fillRect(x, y, cell, cell);
    }
  }
  ctx.restore();
}

function drawGridLines(ctx: CanvasRenderingContext2D, width: number, height: number, view: ViewState) {
  const cell = Math.max(18, Math.round(42 * view.zoom));
  const startX = ((((width / 2 + view.pan.x) % cell) + cell) % cell);
  const startY = ((((height / 2 + view.pan.y) % cell) + cell) % cell);
  ctx.save();
  ctx.strokeStyle = "rgba(92, 99, 94, 0.55)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = startX; x <= width; x += cell) {
    const gx = Math.round(x) + 0.5;
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, height);
  }
  for (let y = startY; y <= height; y += cell) {
    const gy = Math.round(y) + 0.5;
    ctx.moveTo(0, gy);
    ctx.lineTo(width, gy);
  }
  ctx.stroke();
  ctx.restore();
}

// White frame matching the pixel bounds of the exported atlas. It is derived
// from the placed images' bounding box (plus any manual/square padding), so it
// grows and shifts live as items are dragged around the atlas.
function drawExportRegion(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, view: ViewState, region: ExportRegion) {
  const topLeft = worldToScreen({ x: region.xMin, y: region.yMax }, canvas, view);
  const x = Math.round(topLeft.x) + 0.5;
  const y = Math.round(topLeft.y) + 0.5;
  const w = Math.round(region.width * view.zoom);
  const h = Math.round(region.height * view.zoom);
  ctx.save();
  ctx.strokeStyle = "rgba(244, 241, 232, 0.9)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

function drawRipper(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  view: ViewState,
  ripper: RipperState,
  selected: boolean,
  time: number,
  selectedVertices: Set<string>
) {
  const points = ripper.points.map((point) => worldToScreen(point, canvas, view));
  if (points.length < 3) return;

  ctx.save();

  // Only the active ripper gets the rule-of-thirds guides. Inactive rippers keep
  // their marching ants crawling — just slower and in a muted (not black) tone —
  // so they still read as alive without competing with the selected one.
  if (selected && points.length === 4) drawRuleOfThirds(ctx, points);

  ctx.globalAlpha = selected ? 1 : 0.6;

  // Screen-space cubic controls for curved edges. Straight edges stay as lines.
  const controls = points.map((_, edge) =>
    ripper.edgeCurves?.[edge]
      ? edgeControls(ripper, edge).map((c) => worldToScreen(c, canvas, view)) as [Vec2, Vec2]
      : null
  );

  // A thin dark base underneath keeps the dashes legible over any background.
  // Vertex dragging works via geometric hit-testing (hitVertex), independent of
  // whether the handles below are drawn.
  ctx.lineWidth = selected ? 2 : 1.5;
  ctx.strokeStyle = selected ? "rgba(8, 9, 8, 0.85)" : "rgba(8, 9, 8, 0.55)";
  ctx.setLineDash([]);
  ripperPath(ctx, points, controls);
  ctx.stroke();

  ctx.lineWidth = selected ? 1.5 : 1;
  ctx.strokeStyle = selected ? "#efe5c7" : "#c4baa3";
  ctx.setLineDash([6, 5]);
  // Inactive rippers crawl at roughly half speed so they stay lively but calm.
  ctx.lineDashOffset = -(time / (selected ? 40 : 85));
  ripperPath(ctx, points, controls);
  ctx.stroke();
  ctx.setLineDash([]);

  // Corner handles: shown on the selected ripper, plus any corner that is part of
  // a multi-selection (so marquee-picked corners are visible even on an inactive
  // ripper). Selected corners are larger and use the accent fill.
  ctx.globalAlpha = 1;
  points.forEach((point, index) => {
    const inSelection = selectedVertices.has(vertexKey(ripper.id, index));
    if (!selected && !inSelection) return;
    const size = inSelection ? VERTEX_HANDLE_SELECTED_SIZE : VERTEX_HANDLE_SIZE;
    const half = size / 2;
    const x = Math.round(point.x - half);
    const y = Math.round(point.y - half);
    ctx.fillStyle = inSelection ? "#2f7d6d" : "#efe5c7";
    ctx.fillRect(x, y, size, size);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(8, 9, 8, 0.85)";
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  });

  // Curve control handles (only on curved edges, on the selected ripper): two
  // small circles per edge, each tethered to its anchor corner by a guide line —
  // the familiar Bézier-handle look that signals "drag me to shape the curve".
  if (selected && ripper.edgeCurves) {
    for (let edge = 0; edge < points.length; edge += 1) {
      if (!ripper.edgeCurves[edge]) continue;
      const edgeControl = controls[edge];
      if (!edgeControl) continue;
      const [c1, c2] = edgeControl;
      const anchors = [points[edge]!, points[(edge + 1) % points.length]!];
      [c1, c2].forEach((handle, which) => {
        const anchor = anchors[which]!;
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(239, 229, 199, 0.5)";
        ctx.beginPath();
        ctx.moveTo(anchor.x, anchor.y);
        ctx.lineTo(handle.x, handle.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, CURVE_HANDLE_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = "#efe5c7";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(8, 9, 8, 0.85)";
        ctx.stroke();
      });
    }
  }

  ctx.restore();
}

// Dashed rubber-band box drawn while Shift-dragging on empty canvas.
function drawMarquee(ctx: CanvasRenderingContext2D, box: { x0: number; y0: number; x1: number; y1: number }) {
  const x = Math.min(box.x0, box.x1);
  const y = Math.min(box.y0, box.y1);
  const w = Math.abs(box.x1 - box.x0);
  const h = Math.abs(box.y1 - box.y0);
  ctx.save();
  ctx.fillStyle = "rgba(47, 125, 109, 0.18)";
  ctx.fillRect(x, y, w, h);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(239, 229, 199, 0.85)";
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
  ctx.restore();
}

function drawRuleOfThirds(ctx: CanvasRenderingContext2D, points: Vec2[]) {
  const [tl, tr, br, bl] = points;
  if (!tl || !tr || !br || !bl) return;
  ctx.save();
  ctx.strokeStyle = "rgba(239, 229, 199, 0.35)";
  ctx.lineWidth = 1;
  for (const t of [1 / 3, 2 / 3]) {
    const top = lerpPoint(tl, tr, t);
    const bottom = lerpPoint(bl, br, t);
    const left = lerpPoint(tl, bl, t);
    const right = lerpPoint(tr, br, t);
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.moveTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.stroke();
  }
  ctx.restore();
}

function cachedImageSource(
  image: WorkspaceImageState,
  cache: Map<string, CachedDisplaySource>,
  onReady: () => void
): CachedDisplaySource {
  const cached = cache.get(image.id);
  if (cached?.version === image.version) return cached;
  if (cached) disposePixelImageSource(cached.source);

  const next: CachedDisplaySource = { version: image.version, source: null, loading: true };
  cache.set(image.id, next);
  void pixelImageToImageSource(image.image, { maxSize: WORKSPACE_IMAGE_MAX_DISPLAY_SIZE })
    .then((source) => {
      if (cache.get(image.id) !== next) {
        disposePixelImageSource(source);
        return;
      }
      next.source = source;
      next.loading = false;
      onReady();
    })
    .catch(() => {
      if (cache.get(image.id) === next) next.loading = false;
    });
  return next;
}

function drawImageLoadingPlaceholder(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
  ctx.save();
  ctx.fillStyle = "rgba(21, 23, 22, 0.36)";
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = "rgba(239, 229, 199, 0.45)";
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 5]);
  ctx.strokeRect(x, y, width, height);
  ctx.restore();
}

// A draggable handle around the selected atlas texture: four corners (resize
// both axes), four edge midpoints (resize one axis), and one rotation stem.
interface ImageControl {
  tag: string;
  kind: "corner" | "edge" | "rotate";
  /** Screen-space centre of the handle. */
  screen: Vec2;
  /** World-space fixed point kept pinned while resizing (corners/edges only). */
  anchor?: Vec2;
  /** Which axes a resize drives (corners/edges only). */
  mode?: ResizeMode;
  cursor: string;
}

// All handles for the selected atlas texture, in screen space, honouring the
// texture's rotation. Corner anchors are the diagonally opposite corner; edge
// anchors are the opposite edge midpoint — both stay pinned while dragging.
function imageControls(image: WorkspaceImageState, canvas: HTMLCanvasElement, view: ViewState): ImageControl[] {
  const angle = image.rotation ?? 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Centre-to-edge vectors along the texture's local axes (signed scale keeps
  // flips), so corners/edges follow the rotated, possibly mirrored, rectangle.
  const hw = (image.image.width * image.scale.x) / 2;
  const hh = (image.image.height * image.scale.y) / 2;
  const vx = { x: cos * hw, y: sin * hw };
  const vy = { x: -sin * hh, y: cos * hh };
  const pos = image.position;
  const world = (a: number, b: number): Vec2 => ({ x: pos.x + a * vx.x + b * vy.x, y: pos.y + a * vx.y + b * vy.y });
  const toScreen = (w: Vec2): Vec2 => worldToScreen(w, canvas, view);
  const tl = world(-1, 1);
  const tr = world(1, 1);
  const br = world(1, -1);
  const bl = world(-1, -1);
  const top = world(0, 1);
  const bottom = world(0, -1);
  const right = world(1, 0);
  const left = world(-1, 0);

  // Rotation handle: a fixed screen distance beyond the top-edge midpoint, along
  // the screen-space direction of the local +y axis.
  const topScreen = toScreen(top);
  const dir = { x: vy.x * view.zoom, y: -vy.y * view.zoom };
  const len = Math.hypot(dir.x, dir.y) || 1;
  const rotScreen = { x: topScreen.x + (dir.x / len) * ROT_HANDLE_OFFSET, y: topScreen.y + (dir.y / len) * ROT_HANDLE_OFFSET };

  return [
    { tag: "rot", kind: "rotate", screen: rotScreen, cursor: "grab" },
    { tag: "tl", kind: "corner", screen: toScreen(tl), anchor: br, mode: "corner", cursor: "nwse-resize" },
    { tag: "tr", kind: "corner", screen: toScreen(tr), anchor: bl, mode: "corner", cursor: "nesw-resize" },
    { tag: "br", kind: "corner", screen: toScreen(br), anchor: tl, mode: "corner", cursor: "nwse-resize" },
    { tag: "bl", kind: "corner", screen: toScreen(bl), anchor: tr, mode: "corner", cursor: "nesw-resize" },
    { tag: "t", kind: "edge", screen: topScreen, anchor: bottom, mode: "edge-y", cursor: "ns-resize" },
    { tag: "b", kind: "edge", screen: toScreen(bottom), anchor: top, mode: "edge-y", cursor: "ns-resize" },
    { tag: "r", kind: "edge", screen: toScreen(right), anchor: left, mode: "edge-x", cursor: "ew-resize" },
    { tag: "l", kind: "edge", screen: toScreen(left), anchor: right, mode: "edge-x", cursor: "ew-resize" }
  ];
}

// Pick a handle under the pointer (screen space). Rotation wins over corners,
// corners over edges, so overlapping pickup zones resolve to the finer control.
function hitImageControl(screen: Vec2, image: WorkspaceImageState, canvas: HTMLCanvasElement, view: ViewState): ImageControl | undefined {
  const controls = imageControls(image, canvas, view);
  const near = (control: ImageControl, radius: number) =>
    Math.hypot(control.screen.x - screen.x, control.screen.y - screen.y) <= radius;
  for (const control of controls) if (control.kind === "rotate" && near(control, ROT_HANDLE_HIT_RADIUS)) return control;
  for (const control of controls) if (control.kind === "corner" && near(control, HANDLE_HIT_RADIUS)) return control;
  for (const control of controls) if (control.kind === "edge" && near(control, EDGE_HANDLE_HIT_RADIUS)) return control;
  return undefined;
}

// Resize the texture so the dragged handle follows the pointer while `anchor`
// stays pinned. Work in the texture's local frame so rotated textures resize
// along their own axes; corners drive both axes, edges drive one. Shift locks
// the aspect ratio captured at grab time (proportional resize).
function resizedImageToPointer(
  image: WorkspaceImageState,
  drag: Extract<DragState, { type: "resize" }>,
  pointer: Vec2,
  proportional: boolean
): { position: Vec2; scale: Vec2 } {
  const angle = image.rotation ?? 0;
  const ux = { x: Math.cos(angle), y: Math.sin(angle) };
  const uy = { x: -Math.sin(angle), y: Math.cos(angle) };
  const dx = pointer.x - drag.anchor.x;
  const dy = pointer.y - drag.anchor.y;
  const du = dx * ux.x + dy * ux.y; // extent along local +x
  const dv = dx * uy.x + dy * uy.y; // extent along local +y
  const imgW = image.image.width;
  const imgH = image.image.height;

  if (drag.mode === "edge-x") {
    const mag = Math.max(IMAGE_MIN_SCALE, Math.abs(du) / imgW);
    const sign = du >= 0 ? 1 : -1;
    const half = (mag * imgW) / 2;
    return {
      scale: { x: mag, y: drag.startScale.y },
      position: { x: drag.anchor.x + sign * half * ux.x, y: drag.anchor.y + sign * half * ux.y }
    };
  }

  if (drag.mode === "edge-y") {
    const mag = Math.max(IMAGE_MIN_SCALE, Math.abs(dv) / imgH);
    const sign = dv >= 0 ? 1 : -1;
    const half = (mag * imgH) / 2;
    return {
      scale: { x: drag.startScale.x, y: mag },
      position: { x: drag.anchor.x + sign * half * uy.x, y: drag.anchor.y + sign * half * uy.y }
    };
  }

  let magU = Math.max(IMAGE_MIN_SCALE, Math.abs(du) / imgW);
  let magV = Math.max(IMAGE_MIN_SCALE, Math.abs(dv) / imgH);
  if (proportional) {
    // Scale both axes by the larger factor relative to the grab-time scale so
    // the corner stays under the cursor and the aspect ratio is preserved.
    const baseU = Math.abs(drag.startScale.x) || IMAGE_MIN_SCALE;
    const baseV = Math.abs(drag.startScale.y) || IMAGE_MIN_SCALE;
    const factor = Math.max(magU / baseU, magV / baseV);
    magU = baseU * factor;
    magV = baseV * factor;
  }
  const signU = du >= 0 ? 1 : -1;
  const signV = dv >= 0 ? 1 : -1;
  const halfU = (magU * imgW) / 2;
  const halfV = (magV * imgH) / 2;
  return {
    scale: { x: magU, y: magV },
    position: {
      x: drag.anchor.x + signU * halfU * ux.x + signV * halfV * uy.x,
      y: drag.anchor.y + signU * halfU * ux.y + signV * halfV * uy.y
    }
  };
}

function resizeImageGroupToPointer(
  image: WorkspaceImageState,
  drag: Extract<DragState, { type: "resize" }>,
  pointer: Vec2,
  proportional: boolean
): Array<{ id: string; position: Vec2; scale: Vec2 }> {
  const nextPrimary = resizedImageToPointer(image, drag, pointer, proportional);
  const primaryStart = drag.startImages[drag.id];
  if (!primaryStart) return [];
  const factorX = primaryStart.scale.x === 0 ? 1 : nextPrimary.scale.x / primaryStart.scale.x;
  const factorY = primaryStart.scale.y === 0 ? 1 : nextPrimary.scale.y / primaryStart.scale.y;
  return drag.ids.map((id) => {
    if (id === drag.id) return { id, ...nextPrimary };
    const start = drag.startImages[id];
    if (!start) return { id, position: { ...drag.anchor }, scale: { x: IMAGE_MIN_SCALE, y: IMAGE_MIN_SCALE } };
    return {
      id,
      scale: {
        x: Math.max(IMAGE_MIN_SCALE, Math.abs(start.scale.x * factorX)),
        y: Math.max(IMAGE_MIN_SCALE, Math.abs(start.scale.y * factorY))
      },
      position: {
        x: drag.anchor.x + (start.position.x - drag.anchor.x) * factorX,
        y: drag.anchor.y + (start.position.y - drag.anchor.y) * factorY
      }
    };
  });
}

function drawImageHandles(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, view: ViewState, image: WorkspaceImageState) {
  const controls = imageControls(image, canvas, view);
  const topMid = controls.find((control) => control.tag === "t");
  const rot = controls.find((control) => control.kind === "rotate");
  ctx.save();
  // Stem connecting the top edge to the rotation handle.
  if (topMid && rot) {
    ctx.strokeStyle = "#2f7d6d";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(topMid.screen.x, topMid.screen.y);
    ctx.lineTo(rot.screen.x, rot.screen.y);
    ctx.stroke();
  }
  for (const control of controls) {
    if (control.kind === "rotate") {
      ctx.beginPath();
      ctx.arc(control.screen.x, control.screen.y, ROT_HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = "#efe5c7";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#2f7d6d";
      ctx.stroke();
      continue;
    }
    const size = control.kind === "edge" ? HANDLE_SCREEN_SIZE - 2 : HANDLE_SCREEN_SIZE;
    const half = size / 2;
    const x = Math.round(control.screen.x - half);
    const y = Math.round(control.screen.y - half);
    ctx.fillStyle = "#efe5c7";
    ctx.fillRect(x, y, size, size);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#2f7d6d";
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  }
  ctx.restore();
}

function hitImage(world: Vec2, images: WorkspaceImageState[]): WorkspaceImageState | undefined {
  for (let index = images.length - 1; index >= 0; index -= 1) {
    const image = images[index];
    if (!image) continue;
    const halfWidth = (image.image.width * Math.abs(image.scale.x)) / 2;
    const halfHeight = (image.image.height * Math.abs(image.scale.y)) / 2;
    // Inverse-rotate the cursor into the texture's local frame so the hit test
    // tracks the rotated rectangle rather than its axis-aligned bounding box.
    const angle = image.rotation ?? 0;
    const dx = world.x - image.position.x;
    const dy = world.y - image.position.y;
    const localX = angle ? dx * Math.cos(angle) + dy * Math.sin(angle) : dx;
    const localY = angle ? -dx * Math.sin(angle) + dy * Math.cos(angle) : dy;
    if (Math.abs(localX) <= halfWidth && Math.abs(localY) <= halfHeight) {
      return image;
    }
  }
  return undefined;
}

function snapshotImagePositions(images: WorkspaceImageState[], ids: string[]): Record<string, Vec2> {
  const idSet = new Set(ids);
  const positions: Record<string, Vec2> = {};
  for (const image of images) {
    if (idSet.has(image.id)) positions[image.id] = { ...image.position };
  }
  return positions;
}

function snapshotImageStates(
  images: WorkspaceImageState[],
  ids: string[]
): Record<string, { position: Vec2; scale: Vec2 }> {
  const idSet = new Set(ids);
  const states: Record<string, { position: Vec2; scale: Vec2 }> = {};
  for (const image of images) {
    if (idSet.has(image.id)) {
      states[image.id] = {
        position: { ...image.position },
        scale: { ...image.scale }
      };
    }
  }
  return states;
}

function vertexKey(id: string, index: number): string {
  return `${id}#${index}`;
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function vertexRefsFromKeys(keys: Set<string>): VertexRef[] {
  return [...keys].map((key) => {
    const split = key.lastIndexOf("#");
    return { id: key.slice(0, split), index: Number(key.slice(split + 1)) };
  });
}

// Capture the start positions of every corner that a drag will touch (the
// dragged ripper, needed for Cmd-scaling, plus all rippers owning a group
// corner). Copied so later state changes never mutate the baseline.
function snapshotPoints(rippers: RipperState[], group: VertexRef[], draggedId: string): Record<string, Vec2[]> {
  const ids = new Set<string>([draggedId, ...group.map((ref) => ref.id)]);
  const out: Record<string, Vec2[]> = {};
  for (const ripper of rippers) {
    if (ids.has(ripper.id)) out[ripper.id] = ripper.points.map((point) => ({ x: point.x, y: point.y }));
  }
  return out;
}

// The Cmd-scale transform as a function applied to ANY world point. Pins the
// opposite corner and scales independently along the quad's two edge directions
// (A, B) out of that corner, so the grabbed corner follows the pointer and the
// whole shape — corners and curve controls alike — stretches consistently.
// Returns null when the start quad is degenerate. `start` is the 4 corner
// snapshot, `index` the grabbed corner, `world` the pointer.
function scaleTransform(start: Vec2[], index: number, world: Vec2): ((p: Vec2) => Vec2) | null {
  const anchor = start[(index + 2) % 4];
  const sideA = start[(index + 1) % 4]; // adjacent corner along edge A
  const sideB = start[(index + 3) % 4]; // adjacent corner along edge B
  if (!anchor || !sideA || !sideB) return null;
  const ax = sideA.x - anchor.x, ay = sideA.y - anchor.y;
  const bx = sideB.x - anchor.x, by = sideB.y - anchor.y;
  const det = ax * by - ay * bx;
  if (Math.abs(det) <= 1e-6) return null;
  const wx = world.x - anchor.x, wy = world.y - anchor.y;
  const s = (wx * by - wy * bx) / det; // scale along edge A
  const t = (ax * wy - ay * wx) / det; // scale along edge B
  return (p: Vec2): Vec2 => {
    // Decompose p-anchor onto the (A, B) basis, scale each coordinate, recompose.
    const px = p.x - anchor.x, py = p.y - anchor.y;
    const alpha = (px * by - py * bx) / det;
    const beta = (ax * py - ay * px) / det;
    return {
      x: anchor.x + alpha * s * ax + beta * t * bx,
      y: anchor.y + alpha * s * ay + beta * t * by
    };
  };
}

// Resolve a corner drag to the set of corner moves it implies.
//   Cmd/Ctrl → pin the opposite corner and stretch the quad to the pointer,
//              scaling independently along each of the quad's two edge
//              directions. The two adjacent corners slide along those edges so
//              the shape stays a (possibly rotated) rectangle but is free to
//              change proportions — a square can become any rectangle.
//   group    → translate every selected corner by the same delta.
//   single   → the grabbed corner follows the pointer.
function computeVertexUpdates(
  drag: Extract<DragState, { type: "vertex" }>,
  world: Vec2,
  scaleMode: boolean
): VertexUpdate[] {
  if (scaleMode) {
    const start = drag.startPoints[drag.id];
    const transform = start && start.length === 4 ? scaleTransform(start, drag.index, world) : null;
    if (start && transform) {
      const updates: VertexUpdate[] = [];
      for (let i = 0; i < 4; i += 1) updates[i] = { id: drag.id, index: i, point: transform(start[i]!) };
      return updates;
    }
  }

  if (drag.group.length > 1) {
    const delta = { x: world.x - drag.startWorld.x, y: world.y - drag.startWorld.y };
    const updates: VertexUpdate[] = [];
    for (const ref of drag.group) {
      const point = drag.startPoints[ref.id]?.[ref.index];
      if (point) updates.push({ id: ref.id, index: ref.index, point: { x: point.x + delta.x, y: point.y + delta.y } });
    }
    return updates;
  }

  return [{ id: drag.id, index: drag.index, point: world }];
}

// Corners whose on-screen position falls inside the marquee box.
function pickVerticesInBox(
  box: { x0: number; y0: number; x1: number; y1: number },
  rippers: RipperState[],
  canvas: HTMLCanvasElement | null,
  view: ViewState
): Set<string> {
  const selected = new Set<string>();
  if (!canvas) return selected;
  const minX = Math.min(box.x0, box.x1);
  const maxX = Math.max(box.x0, box.x1);
  const minY = Math.min(box.y0, box.y1);
  const maxY = Math.max(box.y0, box.y1);
  for (const ripper of rippers) {
    ripper.points.forEach((point, index) => {
      const screen = worldToScreen(point, canvas, view);
      if (screen.x >= minX && screen.x <= maxX && screen.y >= minY && screen.y <= maxY) {
        selected.add(vertexKey(ripper.id, index));
      }
    });
  }
  return selected;
}

function hitVertex(world: Vec2, rippers: RipperState[], zoom: number): { ripper: RipperState; index: number } | undefined {
  const radius = VERTEX_HIT_RADIUS / zoom;
  for (let ripperIndex = rippers.length - 1; ripperIndex >= 0; ripperIndex -= 1) {
    const ripper = rippers[ripperIndex];
    if (!ripper) continue;
    for (let index = 0; index < ripper.points.length; index += 1) {
      const point = ripper.points[index]!;
      if (Math.hypot(point.x - world.x, point.y - world.y) <= radius) return { ripper, index };
    }
  }
  return undefined;
}

function hitRipper(world: Vec2, rippers: RipperState[]): RipperState | undefined {
  for (let index = rippers.length - 1; index >= 0; index -= 1) {
    const ripper = rippers[index];
    if (ripper && pointInsidePolygon(world, ripperOutlinePoints(ripper))) return ripper;
  }
  return undefined;
}

// Snap an in-progress atlas drag to its neighbours' edges. The dragged image is
// evaluated at its unsnapped `target` so the result depends only on the cursor,
// not on where a previous frame snapped to (which is what made dragging stick).
// The snap band is divided by zoom so it stays a constant on-screen distance —
// without that it felt huge when zoomed in and unreachable when zoomed out.
function snapImageToNeighbors(
  id: string,
  target: Vec2,
  images: WorkspaceImageState[],
  zoom: number
): Vec2 {
  const dragged = images.find((item) => item.id === id);
  if (!dragged) return target;
  // Edge-snapping assumes axis-aligned rectangles, so a rotated texture (or
  // rotated neighbours) is skipped rather than snapped to a misleading box.
  if (dragged.rotation) return target;
  const moved: AtlasItem = { image: dragged.image, position: target, scale: dragged.scale };
  const neighbors = images.filter((item) => item.id !== id && !item.rotation);
  if (neighbors.length === 0) return target;
  return snapAtlasItem(moved, neighbors, SNAP_DISTANCE / Math.max(zoom, 1e-6));
}

function screenToWorld(screen: Vec2, canvas: HTMLCanvasElement, view: ViewState): Vec2 {
  return {
    x: (screen.x - canvas.clientWidth / 2 - view.pan.x) / view.zoom,
    y: -(screen.y - canvas.clientHeight / 2 - view.pan.y) / view.zoom
  };
}

function worldToScreen(world: Vec2, canvas: HTMLCanvasElement, view: ViewState): Vec2 {
  return {
    x: canvas.clientWidth / 2 + view.pan.x + world.x * view.zoom,
    y: canvas.clientHeight / 2 + view.pan.y - world.y * view.zoom
  };
}

function syncCanvasSize(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function lerpPoint(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// Trace the ripper outline. `corners` and `controls` are already in screen space;
// `controls[i]` is non-null only when that edge is curved.
function ripperPath(ctx: CanvasRenderingContext2D, corners: Vec2[], controls: Array<[Vec2, Vec2] | null>) {
  const first = corners[0];
  if (!first) return;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let edge = 0; edge < corners.length; edge += 1) {
    const end = corners[(edge + 1) % corners.length]!;
    const curve = controls[edge];
    if (curve) {
      const [c1, c2] = curve;
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
    } else {
      ctx.lineTo(end.x, end.y);
    }
  }
  ctx.closePath();
}

// Convert a quadratic Bézier (endpoints p0/p3, single control q) into the
// equivalent cubic controls. Used while creating a curve so a single dragged
// point gives a clean symmetric bend; the two controls then move independently.
function quadraticToCubic(p0: Vec2, p3: Vec2, q: Vec2): [Vec2, Vec2] {
  return [
    { x: p0.x + (2 / 3) * (q.x - p0.x), y: p0.y + (2 / 3) * (q.y - p0.y) },
    { x: p3.x + (2 / 3) * (q.x - p3.x), y: p3.y + (2 / 3) * (q.y - p3.y) }
  ];
}

function distPointToSegment(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function distPointToRipperEdge(point: Vec2, ripper: RipperState, edge: number): number {
  const a = ripper.points[edge]!;
  const b = ripper.points[(edge + 1) % ripper.points.length]!;
  if (!ripper.edgeCurves?.[edge]) return distPointToSegment(point, a, b);

  const [c1, c2] = edgeControls(ripper, edge);
  let best = Infinity;
  let previous = a;
  for (let step = 1; step <= 16; step += 1) {
    const next = cubicBezier(a, c1, c2, b, step / 16);
    best = Math.min(best, distPointToSegment(point, previous, next));
    previous = next;
  }
  return best;
}

// The curve control handle (one of an edge's two cubic controls) under `world`.
// Only the selected ripper renders handles, so only it is hit-tested — invisible
// handles on other rippers must not be draggable/removable or steal hover.
function hitCurveHandle(
  world: Vec2,
  rippers: RipperState[],
  zoom: number,
  selectedId: string | undefined
): { ripper: RipperState; edge: number; which: 0 | 1 } | undefined {
  const radius = CURVE_HANDLE_HIT_PX / zoom;
  for (let ripperIndex = rippers.length - 1; ripperIndex >= 0; ripperIndex -= 1) {
    const ripper = rippers[ripperIndex];
    if (!ripper?.edgeCurves || ripper.id !== selectedId) continue;
    for (let edge = 0; edge < ripper.points.length; edge += 1) {
      if (!ripper.edgeCurves[edge]) continue;
      const controls = edgeControls(ripper, edge);
      for (const which of [0, 1] as const) {
        const c = controls[which];
        if (Math.hypot(c.x - world.x, c.y - world.y) <= radius) return { ripper, edge, which };
      }
    }
  }
  return undefined;
}

// A ripper edge near `world`. Curve creation asks for straight edges only;
// point insertion can include curved edges because the inserted point splits the
// curve into two cubic segments.
function hitEdge(
  world: Vec2,
  rippers: RipperState[],
  zoom: number,
  includeCurved = false
): { ripper: RipperState; edge: number } | undefined {
  const radius = EDGE_HIT_PX / zoom;
  for (let ripperIndex = rippers.length - 1; ripperIndex >= 0; ripperIndex -= 1) {
    const ripper = rippers[ripperIndex];
    if (!ripper) continue;
    for (let edge = 0; edge < ripper.points.length; edge += 1) {
      if (!includeCurved && ripper.edgeCurves?.[edge]) continue;
      if (distPointToRipperEdge(world, ripper, edge) <= radius) return { ripper, edge };
    }
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function updateHoverCursor(
  canvas: HTMLCanvasElement,
  world: Vec2,
  images: WorkspaceImageState[],
  rippers: RipperState[],
  zoom: number,
  kind: WorkspaceKind,
  cmd: boolean,
  selectedId: string | undefined
) {
  if (hitVertex(world, rippers, zoom)) {
    setCanvasCursor(canvas, "pointer");
  } else if (hitCurveHandle(world, rippers, zoom, selectedId)) {
    setCanvasCursor(canvas, "pointer");
  } else if (cmd && hitEdge(world, rippers, zoom)) {
    // Cmd over a straight edge: signal that a click-drag will add a curve point.
    setCanvasCursor(canvas, "copy");
  } else if (hitRipper(world, rippers)) {
    setCanvasCursor(canvas, "move");
  } else if (hitImage(world, images)) {
      setCanvasCursor(canvas, kind === "atlas" ? "move" : "grab");
  } else {
    setCanvasCursor(canvas, "grab");
  }
}

function setCanvasCursor(canvas: HTMLCanvasElement, cursor: string) {
  if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
}
