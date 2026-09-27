/**
 * Looking around an entered panorama (§5): pointer and touch drags, wheel
 * and pinch zoom, arrow keys and controller sticks, with optional inertia.
 * Dragging the image right looks left and dragging it down looks up;
 * wheel-up and pinch-out narrow the vertical field of view. Zoom works on
 * tan(fov/2), exponentially, within `scene.panorama.verticalFovRange`.
 *
 * The model is pure; `attachLookInput` binds it to the canvas and window
 * while the scene holds navigation, and nothing else.
 */
import type { ActionIntentFrame } from "@felipegalind0/gamepad-tools/core";
import { DEG_TO_RAD, RAD_TO_DEG } from "./panoramaMath";

export interface LookState {
  headingDeg: number;
  pitchDeg: number;
  verticalFovDeg: number;
}

export interface LookSettings {
  /** deg per CSS px: `scene.panorama.dragSensitivity`. */
  dragSensitivity: number;
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
/** Pixels in a wheel "line" and a "page", to measure notches alike. */
const WHEEL_LINE_PX = 16;
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
  /** A drag of the image by (dx, dy) CSS px over `dtMs`. */
  drag(dx: number, dy: number, dtMs: number): void;
  release(): void;
  /** Wheel deltaY in CSS px; negative (wheel up) narrows. */
  wheel(deltaPx: number): void;
  /** Pinch from one finger separation to another. */
  pinch(fromPx: number, toPx: number): void;
  /** Held rates: look right/up and zoom in, each −1 to 1. */
  setRates(rates: { lookX: number; lookY: number; zoom: number }): void;
  /** Advances held rates and inertia; returns whether anything is still moving. */
  step(dtMs: number): boolean;
  moving(): boolean;
  cancelInertia(): void;
}

export function createLookModel(initial: LookState, settings: () => LookSettings, onChange: (state: LookState) => void): LookModel {
  let state = clampLook(initial, settings());
  let velocity = { heading: 0, pitch: 0 };
  let rates = { lookX: 0, lookY: 0, zoom: 0 };
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
      if (dtMs > 0) velocity = { heading: (heading / dtMs) * 1000, pitch: (pitch / dtMs) * 1000 };
      apply({ ...state, headingDeg: state.headingDeg + heading, pitchDeg: state.pitchDeg + pitch });
    },
    release() {
      const current = settings();
      if (current.reducedMotion || current.inertiaHalfLifeMs <= 0) velocity = { heading: 0, pitch: 0 };
    },
    wheel(deltaPx) {
      apply({ ...state, verticalFovDeg: zoomFov(state.verticalFovDeg, (-deltaPx / WHEEL_NOTCH_PX) * settings().zoomPerNotch) });
    },
    pinch(fromPx, toPx) {
      if (!(fromPx > 0 && toPx > 0)) return;
      apply({ ...state, verticalFovDeg: zoomFov(state.verticalFovDeg, Math.log(toPx / fromPx) * settings().pinchGain) });
    },
    setRates(next) {
      rates = next;
      if (next.lookX || next.lookY) velocity = { heading: 0, pitch: 0 };
    },
    step(dtMs) {
      const current = settings();
      const dt = Math.max(0, Math.min(dtMs, 100)) / 1000;
      let next = state;
      if (rates.lookX || rates.lookY || rates.zoom) {
        next = {
          headingDeg: next.headingDeg + rates.lookX * current.lookRate * dt,
          pitchDeg: next.pitchDeg + rates.lookY * current.lookRate * dt,
          verticalFovDeg: zoomFov(next.verticalFovDeg, rates.zoom * current.zoomRate * dt),
        };
      }
      if (velocity.heading || velocity.pitch) {
        if (current.reducedMotion || current.inertiaHalfLifeMs <= 0) {
          velocity = { heading: 0, pitch: 0 };
        } else {
          next = { ...next, headingDeg: next.headingDeg + velocity.heading * dt, pitchDeg: next.pitchDeg + velocity.pitch * dt };
          const decay = Math.pow(0.5, (dt * 1000) / current.inertiaHalfLifeMs);
          velocity = { heading: velocity.heading * decay, pitch: velocity.pitch * decay };
          if (Math.hypot(velocity.heading, velocity.pitch) < INERTIA_STOP_DEG_PER_S) velocity = { heading: 0, pitch: 0 };
        }
      }
      if (next !== state) apply(next);
      return this.moving();
    },
    moving: () => Boolean(rates.lookX || rates.lookY || rates.zoom || velocity.heading || velocity.pitch),
    cancelInertia() {
      velocity = { heading: 0, pitch: 0 };
    },
  };
}

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit", "reset"].includes(target.type);
}

export interface LookInputOptions {
  canvas: HTMLElement;
  model: LookModel;
  /** Escape and the controller's exit. */
  onExit(): void;
  /** Any look input: cancels an entry's expansion or an arrival's levelling. */
  onUserInput(): void;
  /** Something moved: a frame is needed. */
  requestFrame(): void;
  /** Whether a binding is being captured, which keeps input. */
  capturing?: () => boolean;
}

/** Binds look input; returns the controller-intent handler and a detach function. */
export function attachLookInput(options: LookInputOptions): { applyIntents(frame: ActionIntentFrame): void; detach(): void } {
  const { canvas, model } = options;
  const pointers = new Map<number, { x: number; y: number; at: number }>();
  let pinchFrom: number | null = null;
  const keys = new Set<string>();
  const padRates = { lookX: 0, lookY: 0, zoom: 0 };

  const syncRates = (): void => {
    const key = (name: string) => (keys.has(name) ? 1 : 0);
    const zoomKeys = key("+") + key("=") - key("-") - key("_");
    model.setRates({
      lookX: Math.max(-1, Math.min(1, key("ArrowRight") - key("ArrowLeft") + padRates.lookX)),
      lookY: Math.max(-1, Math.min(1, key("ArrowUp") - key("ArrowDown") + padRates.lookY)),
      zoom: Math.max(-1, Math.min(1, zoomKeys + padRates.zoom)),
    });
    if (model.moving()) options.requestFrame();
  };

  const separation = (): number => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    model.cancelInertia();
    options.onUserInput();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, at: event.timeStamp });
    try { canvas.setPointerCapture(event.pointerId); } catch { /* the pointer may already be gone */ }
    pinchFrom = pointers.size === 2 ? separation() : null;
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent): void => {
    const last = pointers.get(event.pointerId);
    if (!last) return;
    const current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    pointers.set(event.pointerId, current);
    if (pointers.size >= 2) {
      const now = separation();
      if (pinchFrom !== null) model.pinch(pinchFrom, now);
      pinchFrom = now;
    } else {
      model.drag(current.x - last.x, current.y - last.y, current.at - last.at);
    }
    options.requestFrame();
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (!pointers.delete(event.pointerId)) return;
    pinchFrom = pointers.size === 2 ? separation() : null;
    if (pointers.size === 0) {
      model.release();
      if (model.moving()) options.requestFrame();
    }
  };
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    options.onUserInput();
    const scale = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? WHEEL_NOTCH_PX * 3 : 1;
    model.wheel(event.deltaY * scale);
    options.requestFrame();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isTextField(event.target) || options.capturing?.()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      options.onExit();
      return;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "_"].includes(event.key)) {
      event.preventDefault();
      options.onUserInput();
      keys.add(event.key);
      syncRates();
    }
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (keys.delete(event.key)) syncRates();
  };
  const onBlur = (): void => {
    keys.clear();
    pointers.clear();
    syncRates();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  return {
    applyIntents(frame) {
      let changed = false;
      for (const intent of frame.intents) {
        if (intent.kind === "command" && intent.actionId === "panorama.exit" && intent.edge === "press") options.onExit();
        if (intent.kind !== "rate") continue;
        const value = Number.isFinite(intent.value) ? Math.max(-1, Math.min(1, intent.value)) : 0;
        if (intent.actionId === "panorama.lookX") { padRates.lookX = value; changed = true; }
        if (intent.actionId === "panorama.lookY") { padRates.lookY = value; changed = true; }
        if (intent.actionId === "panorama.zoom") { padRates.zoom = value; changed = true; }
      }
      if (changed) {
        if (padRates.lookX || padRates.lookY || padRates.zoom) options.onUserInput();
        syncRates();
      }
    },
    detach() {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      for (const id of pointers.keys()) { try { canvas.releasePointerCapture(id); } catch { /* released */ } }
      pointers.clear();
      keys.clear();
      model.setRates({ lookX: 0, lookY: 0, zoom: 0 });
      model.cancelInertia();
    },
  };
}
