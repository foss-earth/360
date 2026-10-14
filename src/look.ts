/** Retained sphere look model, ticked by the host frame only. */
import type { TouchPair } from "./cameraTarget.js";
import { anchorSphereCamera, sphereRay, type SpherePoint, type SpherePoseLimits, type SphereViewport } from "./sphereCamera.js";
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
export interface LookState {
  headingDeg: number;
  pitchDeg: number;
  verticalFovDeg: number;
}

export interface LookSettings {
  /** deg per CSS px: `scene.panorama.dragSensitivity`. */
  dragSensitivity: number;
  /** deg per CSS px of a trackpad swipe's scroll: `scene.panorama.swipeSensitivity`. */
  swipeSensitivity: number;
  /** deg/s for keys and a full stick: `lookRate`. */
  lookRate: number;
  /** log-tan-FOV per wheel notch and per second: `zoomPerNotch`, `zoomRate`. */
  zoomPerNotch: number;
  zoomRate: number;
  pinchGain: number;
  /** ms; 0 turns inertia off: `inertiaHalfLife`. */
  inertiaHalfLifeMs: number;
  fovRangeDeg: { min: number; max: number };
  pitchRangeDeg: { min: number; max: number };
  reducedMotion: boolean;
}

/** Below this angular speed, deg/s, inertia has stopped. */
const INERTIA_STOP_DEG_PER_S = 0.05;
/** A drag held still this long, ms, before its release has no glide. */
const GLIDE_RELEASE_WINDOW_MS = 80;
const WHEEL_NOTCH_PX = 100;

export function clampLook(state: LookState, settings: LookSettings): LookState {
  return {
    headingDeg: ((state.headingDeg % 360) + 360) % 360,
    pitchDeg: Math.min(settings.pitchRangeDeg.max, Math.max(settings.pitchRangeDeg.min, state.pitchDeg)),
    verticalFovDeg: Math.min(settings.fovRangeDeg.max, Math.max(settings.fovRangeDeg.min, state.verticalFovDeg)),
  };
}

/** Multiplies tan(fov/2) by exp(−amount): positive amounts narrow the view. */
export function zoomFov(fovDeg: number, amount: number): number {
  return 2 * Math.atan(Math.tan((fovDeg * DEG_TO_RAD) / 2) * Math.exp(-amount)) * RAD_TO_DEG;
}

export interface LookModel {
  get(): LookState;
  set(state: LookState): void;
  /** A drag of the image by (dx, dy) CSS px over `dtMs`. Its speed glides on only after the release. */
  drag(dx: number, dy: number, dtMs: number): void;
  /** The drag ends, `stillMs` after its last move: a drag held still before the release has no glide. */
  release(stillMs?: number): void;
  /** Wheel deltaY in CSS px; negative (wheel up) narrows. `at` anchors the ray there. */
  wheel(deltaPx: number, at?: SpherePoint | null): void;
  /** A trackpad swipe's scroll deltas, CSS px: it moves the image as a drag the other way does. */
  swipe(deltaX: number, deltaY: number): void;
  /** Zooms by a pinch's scale change as a natural logarithm; positive (fingers apart) narrows. `at` anchors the ray there. */
  pinchBy(logScale: number, at?: SpherePoint | null): void;
  /** Pinch from one finger separation to another. */
  pinch(fromPx: number, toPx: number): void;
  /** Two touches moved: separation and midpoint motion are one anchored update when the view is measured. */
  touchPinch(from: TouchPair, to: TouchPair): void;
  /** Held rates: look right/up and zoom in, each −1 to 1. */
  setRates(rates: { lookX: number; lookY: number; zoom: number }): void;
  /** Advances held rates and inertia; returns whether anything is still moving. */
  step(dtMs: number): boolean;
  moving(): boolean;
  cancelInertia(): void;
}

export function createLookModel(initial: LookState, settings: () => LookSettings, onChange: (state: LookState) => void, viewport?: () => SphereViewport | null): LookModel {
  let state = clampLook(initial, settings());
  const readViewport = (): SphereViewport | null => {
    const view = viewport?.() ?? null;
    return view && view.width > 0 && view.height > 0 ? view : null;
  };
  const limitsOf = (current: LookSettings): SpherePoseLimits => ({ fovDeg: current.fovRangeDeg, pitchDeg: current.pitchRangeDeg });
  /** Zoom by `amount` on tan(fov/2). A measured view keeps the ray under `at` on the way to `to`. */
  const anchored = (next: LookState, amount: number, at: SpherePoint | null, to: SpherePoint | null): LookState => {
    const requested = zoomFov(next.verticalFovDeg, amount);
    const view = readViewport();
    if (!view) return { ...next, verticalFovDeg: requested };
    const from = at ?? { x: view.width / 2, y: view.height / 2 };
    const ray = sphereRay(next, view, from);
    return anchorSphereCamera(next, view, ray, to ?? from, requested, limitsOf(settings()), from);
  };
  let velocity = { heading: 0, pitch: 0 };
  let rates = { lookX: 0, lookY: 0, zoom: 0 };
  // While a drag holds the image, its speed is kept for the release, not applied.
  let held = false;
  const apply = (next: LookState): void => {
    state = clampLook(next, settings());
    onChange(state);
  };
  return {
    get: () => state,
    set(next) {
      velocity = { heading: 0, pitch: 0 };
      apply(next);
    },
    drag(dx, dy, dtMs) {
      const gain = settings().dragSensitivity;
      const heading = -dx * gain;
      const pitch = dy * gain;
      held = true;
      if (dtMs > 0) velocity = { heading: (heading / dtMs) * 1000, pitch: (pitch / dtMs) * 1000 };
      apply({ ...state, headingDeg: state.headingDeg + heading, pitchDeg: state.pitchDeg + pitch });
    },
    release(stillMs = 0) {
      held = false;
      const current = settings();
      if (current.reducedMotion || current.inertiaHalfLifeMs <= 0 || stillMs > GLIDE_RELEASE_WINDOW_MS) velocity = { heading: 0, pitch: 0 };
    },
    wheel(deltaPx, at) {
      apply(anchored(state, (-deltaPx / WHEEL_NOTCH_PX) * settings().zoomPerNotch, at ?? null, null));
    },
    swipe(deltaX, deltaY) {
      // The OS applies the scroll direction the person chose, and momentum after the fingers lift.
      const gain = settings().swipeSensitivity;
      velocity = { heading: 0, pitch: 0 };
      apply({ ...state, headingDeg: state.headingDeg + deltaX * gain, pitchDeg: state.pitchDeg - deltaY * gain });
    },
    pinch(fromPx, toPx) {
      if (!(fromPx > 0 && toPx > 0)) return;
      this.pinchBy(Math.log(toPx / fromPx));
    },
    touchPinch(from, to) {
      if (!(from.separation > 0 && to.separation > 0)) return;
      apply(anchored(state, Math.log(to.separation / from.separation) * settings().pinchGain, from.mid, to.mid));
    },
    pinchBy(logScale, at) {
      if (!Number.isFinite(logScale)) return;
      apply(anchored(state, logScale * settings().pinchGain, at ?? null, null));
    },
    setRates(next) {
      rates = next;
      if (next.lookX || next.lookY) velocity = { heading: 0, pitch: 0 };
    },
    step(dtMs) {
      const current = settings();
      const dt = Math.max(0, Math.min(dtMs, 100)) / 1000;
      let next = state;
      if (rates.lookX || rates.lookY) {
        next = {
          ...next,
          headingDeg: next.headingDeg + rates.lookX * current.lookRate * dt,
          pitchDeg: next.pitchDeg + rates.lookY * current.lookRate * dt,
        };
      }
      if (!held && (velocity.heading || velocity.pitch)) {
        if (current.reducedMotion || current.inertiaHalfLifeMs <= 0) {
          velocity = { heading: 0, pitch: 0 };
        } else {
          next = { ...next, headingDeg: next.headingDeg + velocity.heading * dt, pitchDeg: next.pitchDeg + velocity.pitch * dt };
          const decay = Math.pow(0.5, (dt * 1000) / current.inertiaHalfLifeMs);
          velocity = { heading: velocity.heading * decay, pitch: velocity.pitch * decay };
          if (Math.hypot(velocity.heading, velocity.pitch) < INERTIA_STOP_DEG_PER_S) velocity = { heading: 0, pitch: 0 };
        }
      }
      if (rates.zoom) next = anchored(next, rates.zoom * current.zoomRate * dt, null, null);
      if (next !== state) apply(next);
      return this.moving();
    },
    moving: () => Boolean(rates.lookX || rates.lookY || rates.zoom || (!held && (velocity.heading || velocity.pitch))),
    cancelInertia() {
      velocity = { heading: 0, pitch: 0 };
    },
  };
}
