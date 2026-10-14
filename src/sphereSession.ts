/**
 * What a sphere image surface shows, and the one publisher a slot uses
 * (docs/proposals/shared-image-viewer-implementation.md §5, §7). Every sphere
 * source shares one camera: swapping sides, dropping to one side, or clearing
 * the surface does not invent a new pose. A wipe never touches the camera.
 * Geographic placement is not part of this state.
 */
import type { SphereCamera, SpherePoseLimits, SphereViewport } from "./sphereCamera.js";

export type SphereSide = "left" | "right";

/** A participating document. Its pixels are published separately, atomically. */
export interface SphereSlotDocument {
  readonly tabId: string;
  readonly documentId: string;
  readonly revision: string;
  readonly title: string;
}

export type SphereSurfacePresentation =
  | { readonly kind: "none" }
  | { readonly kind: "single"; readonly side: SphereSide; readonly document: SphereSlotDocument }
  | { readonly kind: "pair"; readonly left: SphereSlotDocument; readonly right: SphereSlotDocument };

export interface SphereSurfaceState {
  readonly presentation: SphereSurfacePresentation;
  readonly camera: SphereCamera | null;
  readonly viewport: SphereViewport;
  /** 0 shows the right source only, 1 the left only. */
  readonly wipe: number;
}

const INITIAL_FOV_DEG = 60;

export function initialSphereCamera(limits?: SpherePoseLimits): SphereCamera {
  const pitch = limits ? Math.min(limits.pitchDeg.max, Math.max(limits.pitchDeg.min, 0)) : 0;
  const fov = limits ? Math.min(limits.fovDeg.max, Math.max(limits.fovDeg.min, INITIAL_FOV_DEG)) : INITIAL_FOV_DEG;
  return { headingDeg: 0, pitchDeg: pitch, verticalFovDeg: fov };
}

export function initialSphereSurfaceState(viewport: SphereViewport = { width: 0, height: 0 }): SphereSurfaceState {
  return { presentation: { kind: "none" }, camera: null, viewport, wipe: 0.5 };
}

/**
 * Moves the surface to a new presentation. The camera stays, including across
 * an empty surface, so a source that returns is still the view that left.
 * The first source to arrive, when there is no camera yet, starts level,
 * facing forward, at 60° (clamped to the supplied limits).
 */
export function presentSphereSurface(state: SphereSurfaceState, presentation: SphereSurfacePresentation, limits?: SpherePoseLimits): SphereSurfaceState {
  if (presentation.kind === "none" || state.camera) return { ...state, presentation };
  return { ...state, presentation, camera: initialSphereCamera(limits) };
}

export function resizeSphereSurface(state: SphereSurfaceState, viewport: SphereViewport): SphereSurfaceState {
  if (viewport.width === state.viewport.width && viewport.height === state.viewport.height) return state;
  return { ...state, viewport };
}

export function withSphereCamera(state: SphereSurfaceState, camera: SphereCamera): SphereSurfaceState {
  return state.camera === camera ? state : { ...state, camera };
}

/** Wipe changes never touch the camera. */
export function setSphereWipe(state: SphereSurfaceState, wipe: number): SphereSurfaceState {
  if (!Number.isFinite(wipe)) return state;
  const next = Math.min(1, Math.max(0, wipe));
  return next === state.wipe ? state : { ...state, wipe: next };
}

export interface SphereSlot<T> {
  /** The generation a publish must name. It advances on revise and on clear. */
  readonly generation: number;
  /** The last source this generation accepted, or null after a clear. */
  readonly published: T | null;
  /** Starts a replacement. The published source stays until that replacement publishes. */
  revise(): number;
  /** Drops the published source and retires every token, including one already issued. */
  clear(): void;
  /**
   * Publishes `source` as one assignment when `token` is still the generation.
   * A stale or cancelled token leaves the published source unchanged.
   */
  publish(token: number, source: T): boolean;
}

/** One publisher. A tiled residency may mutate the published source in place; that is not a second publish. */
export function createSphereSlot<T>(): SphereSlot<T> {
  let generation = 0;
  let published: T | null = null;
  return {
    get generation() { return generation; },
    get published() { return published; },
    revise() { generation += 1; return generation; },
    clear() { generation += 1; published = null; },
    publish(token, source) {
      if (token !== generation) return false;
      published = source;
      return true;
    },
  };
}
