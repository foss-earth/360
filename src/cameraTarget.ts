/**
 * What one input binding drives (docs/proposals/shared-image-viewer-implementation.md
 * §8): the normalized gestures a rectangle or sphere camera interprets. Points
 * are surface-local CSS pixels; a null point anchors at the surface's centre.
 */
import { createLookModel, type LookModel, type LookSettings } from "./look.js";
import {
  panRectangleCamera,
  pinchRectangleCamera,
  zoomRectangleCamera,
  type RectangleCamera,
  type RectanglePoint,
  type RectangleScaleLimits,
  type RectangleViewportSize,
} from "./rectangleCamera.js";
import type { SphereCamera, SphereViewport } from "./sphereCamera.js";

export type SurfacePoint = RectanglePoint;

/** Two touches: their midpoint and separation, CSS px. */
export interface TouchPair {
  readonly mid: SurfacePoint;
  readonly separation: number;
}

/** An image gesture's actual anchor, projected into surface-local CSS pixels. */
export interface ImageCameraAnchor extends SurfacePoint {
  readonly grab: boolean;
  readonly zoom: boolean;
  /** False while a released grab is only gliding. */
  readonly held: boolean;
}

export interface ImageCameraTarget {
  /** The projected image point the current gesture holds, when supported. */
  anchor?(): ImageCameraAnchor | null;
  /** Camera motion and gesture changes, including the end of a glide. */
  subscribeAnchors?(changed: () => void): () => void;
  /** A drag from `from` by (dx, dy) CSS px over `dtMs`. */
  drag(dx: number, dy: number, dtMs: number, from?: SurfacePoint | null): void;
  /** The drag ends, `stillMs` after its last move. */
  release(stillMs?: number): void;
  /** Wheel deltaY in CSS px at a point; negative (wheel up) magnifies. */
  wheel(deltaPx: number, at?: SurfacePoint | null): void;
  /** Scroll deltas in the person's chosen direction. Continuing swipes keep the image point where the gesture began. */
  swipe(deltaX: number, deltaY: number, at?: SurfacePoint | null, continuing?: boolean): void;
  /** A pinch's scale change as a natural logarithm at a point; positive (fingers apart) magnifies. */
  pinchBy(logScale: number, at?: SurfacePoint | null): void;
  /** Two touches moved: separation and midpoint motion in one update. */
  touchPinch(from: TouchPair, to: TouchPair): void;
  /** Held rates: look right/up and zoom in, each −1 to 1. */
  setRates(rates: { lookX: number; lookY: number; zoom: number }): void;
  /** Advances held rates and any glide; returns whether anything is still moving. */
  step(dtMs: number): boolean;
  moving(): boolean;
  cancelInertia(): void;
}

/** Rectangle zoom per wheel notch of 100 CSS px: 1.25 times. */
export const RECTANGLE_ZOOM_PER_NOTCH = Math.log(1.25);
/** Held pan speed, CSS px per second at full rate. */
export const RECTANGLE_PAN_RATE_PX_PER_S = 600;
/** Held zoom, natural log per second at full rate: doubling each second. */
export const RECTANGLE_ZOOM_RATE_PER_S = Math.log(2);
const WHEEL_NOTCH_PX = 100;

export interface RectangleCameraTargetPorts {
  /** The surface's camera, or null while it has none. */
  get(): RectangleCamera | null;
  set(camera: RectangleCamera): void;
  viewport(): RectangleViewportSize;
  limits(): RectangleScaleLimits;
}

/**
 * The rectangle camera as an input target. Every anchored change keeps the plane
 * point under the anchor; there is no glide after a drag, and a swipe's
 * momentum is the operating system's own.
 */
export function createRectangleCameraTarget(ports: RectangleCameraTargetPorts): ImageCameraTarget {
  let rates = { lookX: 0, lookY: 0, zoom: 0 };
  const centre = (): SurfacePoint => {
    const { width, height } = ports.viewport();
    return { x: width / 2, y: height / 2 };
  };
  const update = (change: (camera: RectangleCamera) => RectangleCamera): void => {
    const camera = ports.get();
    if (!camera) return;
    const next = change(camera);
    if (next !== camera) ports.set(next);
  };
  const zoomBy = (logScale: number, at: SurfacePoint | null | undefined): void => {
    if (!Number.isFinite(logScale) || logScale === 0) return;
    update(camera => zoomRectangleCamera(camera, at ?? centre(), camera.scale * Math.exp(logScale), ports.limits()));
  };
  return {
    drag(dx, dy) {
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      update(camera => panRectangleCamera(camera, dx, dy));
    },
    release() {},
    wheel(deltaPx, at) {
      zoomBy((-deltaPx / WHEEL_NOTCH_PX) * RECTANGLE_ZOOM_PER_NOTCH, at);
    },
    swipe(deltaX, deltaY) {
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
      // Scrolling moves the view by the deltas, so the image moves the other way.
      update(camera => panRectangleCamera(camera, -deltaX, -deltaY));
    },
    pinchBy(logScale, at) {
      zoomBy(logScale, at);
    },
    touchPinch(from, to) {
      if (!(from.separation > 0 && to.separation > 0)) return;
      update(camera => pinchRectangleCamera(camera, from.mid, to.mid, to.separation / from.separation, ports.limits()));
    },
    setRates(next) {
      rates = { lookX: next.lookX || 0, lookY: next.lookY || 0, zoom: next.zoom || 0 };
    },
    step(dtMs) {
      if (!this.moving()) return false;
      const dt = Math.max(0, Math.min(dtMs, 100)) / 1000;
      // Looking right or up moves the view that way: the image moves left or down.
      update(camera => panRectangleCamera(camera, -rates.lookX * RECTANGLE_PAN_RATE_PX_PER_S * dt, rates.lookY * RECTANGLE_PAN_RATE_PX_PER_S * dt));
      zoomBy(rates.zoom * RECTANGLE_ZOOM_RATE_PER_S * dt, null);
      return this.moving();
    },
    moving: () => rates.lookX !== 0 || rates.lookY !== 0 || rates.zoom !== 0,
    cancelInertia() {},
  };
}

export interface SphereCameraTargetPorts {
  /** The surface's camera, or null while it has none. */
  get(): SphereCamera | null;
  set(camera: SphereCamera): void;
  /** The measured view, the same rectangle pointer conversion uses. */
  viewport(): SphereViewport;
  settings(): LookSettings;
}

/**
 * The sphere camera as an input target. Drag, swipe, zoom and pinch keep the
 * common-space ray under the gesture using the measured view. Held rates
 * change the live look's heading and pitch.
 */
export function createSphereCameraTarget(ports: SphereCameraTargetPorts): ImageCameraTarget {
  let model: LookModel | null = null;
  const anchorListeners = new Set<() => void>();
  const ensure = (): LookModel | null => {
    const current = ports.get();
    if (!current) return null;
    if (!model) {
      model = createLookModel(current, ports.settings, next => ports.set(next), () => ports.viewport());
      model.subscribeAnchors(() => { for (const listener of anchorListeners) listener(); });
      return model;
    }
    const held = model.get();
    if (held.headingDeg !== current.headingDeg || held.pitchDeg !== current.pitchDeg || held.verticalFovDeg !== current.verticalFovDeg) model.set(current);
    return model;
  };
  return {
    anchor: () => ensure()?.anchor() ?? null,
    subscribeAnchors(changed) {
      anchorListeners.add(changed);
      return () => { anchorListeners.delete(changed); };
    },
    drag(dx, dy, dt, from) { ensure()?.drag(dx, dy, dt, from); },
    release(still) { model?.release(still); },
    wheel(delta, at) { ensure()?.wheel(delta, at); },
    swipe(dx, dy, at, continuing) { ensure()?.swipe(dx, dy, at, continuing); },
    pinchBy(log, at) { ensure()?.pinchBy(log, at); },
    touchPinch(from, to) { ensure()?.touchPinch(from, to); },
    setRates(rates) { ensure()?.setRates(rates); },
    step(dt) { return ensure()?.step(dt) ?? false; },
    moving: () => model?.moving() ?? false,
    cancelInertia() { model?.cancelInertia(); },
  };
}
