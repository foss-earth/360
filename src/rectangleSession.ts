import { sameRectangleAspect, type RectangleImageSize } from "@foss-earth/rectangle-image/core";
import { fitRectangleCamera, resizeRectangleCamera, type RectangleCamera, type RectangleExtent, type RectangleViewportSize } from "./rectangleCamera.js";

/**
 * What a rectangle image surface shows: which documents take part, whether they
 * can share one camera, the canonical extent, the camera and the wipe. Pure
 * state; the host derives the slots from its tabs and the viewer draws it.
 */

export type RectangleSide = "left" | "right";

/** A participating document: the selected image tab on a side. Minimizing that window does not remove it. */
export interface RectangleSlotDocument {
  readonly tabId: string;
  readonly documentId: string;
  readonly revision: string;
  readonly title: string;
  /** Native pixel size once discovered; null while it is still being read. */
  readonly size: RectangleImageSize | null;
}

export type RectangleSurfacePresentation =
  | { readonly kind: "none" }
  | { readonly kind: "single"; readonly side: RectangleSide; readonly document: RectangleSlotDocument }
  | { readonly kind: "pair"; readonly left: RectangleSlotDocument; readonly right: RectangleSlotDocument }
  | { readonly kind: "incompatible"; readonly left: RectangleSlotDocument; readonly right: RectangleSlotDocument; readonly reason: string };

/**
 * The table in section 5 of the specification. Two rectangle images share a camera
 * only with exactly the same aspect ratio; until both sizes are known the pair
 * is presented, its unread side loading, and the camera waits for neither.
 */
export function rectangleSurfacePresentation(left: RectangleSlotDocument | null, right: RectangleSlotDocument | null): RectangleSurfacePresentation {
  if (!left && !right) return { kind: "none" };
  if (!left || !right) return { kind: "single", side: left ? "left" : "right", document: (left ?? right)! };
  if (left.size && right.size && !sameRectangleAspect(left.size, right.size)) {
    return {
      kind: "incompatible", left, right,
      reason: `${left.title} is ${left.size.width} × ${left.size.height} and ${right.title} is ${right.size.width} × ${right.size.height}. `
        + "Their aspect ratios differ, so they cannot share one view without registration, which is not supported yet.",
    };
  }
  return { kind: "pair", left, right };
}

/** The documents a presentation draws, left first. */
export function rectanglePresentedDocuments(presentation: RectangleSurfacePresentation): RectangleSlotDocument[] {
  switch (presentation.kind) {
    case "none": return [];
    case "single": return [presentation.document];
    case "pair": return [presentation.left, presentation.right];
    case "incompatible": return [];
  }
}

export interface RectangleSurfaceState {
  readonly presentation: RectangleSurfacePresentation;
  /** The canonical plane: the first displayed image's size, kept across compatible changes and swaps. */
  readonly extent: RectangleExtent | null;
  readonly camera: RectangleCamera | null;
  readonly viewport: RectangleViewportSize;
  /** 0 shows the right source only, 1 the left only. */
  readonly wipe: number;
  /** Views of documents that left the surface for an incompatible one, restored when they return. */
  readonly savedViews: ReadonlyMap<string, { readonly extent: RectangleExtent; readonly camera: RectangleCamera }>;
}

export function initialRectangleSurfaceState(viewport: RectangleViewportSize = { width: 0, height: 0 }): RectangleSurfaceState {
  return { presentation: { kind: "none" }, extent: null, camera: null, viewport, wipe: 0.5, savedViews: new Map() };
}

function sizeOf(presentation: RectangleSurfacePresentation): RectangleImageSize | null {
  for (const document of rectanglePresentedDocuments(presentation)) if (document.size) return document.size;
  return null;
}

/**
 * Moves the surface to a new presentation. A compatible change keeps the
 * extent and camera, so swapping sides or switching to another rendition of
 * the same framing never refits. A change to another aspect saves the old
 * view, then restores the newcomer's saved view or fits it.
 */
export function presentRectangleSurface(state: RectangleSurfaceState, presentation: RectangleSurfacePresentation): RectangleSurfaceState {
  const size = sizeOf(presentation);
  if (!size) return { ...state, presentation };
  if (state.extent && state.camera && sameRectangleAspect(state.extent, size)) return { ...state, presentation };
  const savedViews = new Map(state.savedViews);
  if (state.extent && state.camera) {
    for (const document of rectanglePresentedDocuments(state.presentation)) savedViews.set(document.documentId, { extent: state.extent, camera: state.camera });
  }
  const restored = rectanglePresentedDocuments(presentation).map(document => savedViews.get(document.documentId)).find(view => view && sameRectangleAspect(view.extent, size));
  if (restored) return { ...state, presentation, extent: restored.extent, camera: restored.camera, savedViews };
  const extent = { width: size.width, height: size.height };
  return { ...state, presentation, extent, camera: fitRectangleCamera(extent, state.viewport), savedViews };
}

/** The surface's measured size changed: the scale and the centre's plane point stay. */
export function resizeRectangleSurface(state: RectangleSurfaceState, viewport: RectangleViewportSize): RectangleSurfaceState {
  if (viewport.width === state.viewport.width && viewport.height === state.viewport.height) return state;
  if (!state.camera || !(state.viewport.width > 0 && state.viewport.height > 0)) {
    return { ...state, viewport, camera: state.extent ? fitRectangleCamera(state.extent, viewport) : state.camera };
  }
  return { ...state, viewport, camera: resizeRectangleCamera(state.camera, state.viewport, viewport) };
}

export function withRectangleCamera(state: RectangleSurfaceState, camera: RectangleCamera): RectangleSurfaceState {
  return state.camera === camera ? state : { ...state, camera };
}

export function fitRectangleSurface(state: RectangleSurfaceState): RectangleSurfaceState {
  return state.extent ? { ...state, camera: fitRectangleCamera(state.extent, state.viewport) } : state;
}

/** Wipe changes never touch the camera. */
export function setRectangleWipe(state: RectangleSurfaceState, wipe: number): RectangleSurfaceState {
  if (!Number.isFinite(wipe)) return state;
  const next = Math.min(1, Math.max(0, wipe));
  return next === state.wipe ? state : { ...state, wipe: next };
}

/** Which source a surface-local x shows: left below the wipe, right at or above it. */
export function rectangleWipeSide(localX: number, width: number, wipe: number): RectangleSide {
  return localX / width < wipe ? "left" : "right";
}
