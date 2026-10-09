/** Browser input binds only while the host viewer has navigation. */
import type { ActionIntentFrame } from "@felipegalind0/gamepad-tools/core";
import type { LookModel } from "./look.js";
const WHEEL_LINE_PX = 16;
const WHEEL_NOTCH_PX = 100;
const PINCH_WHEEL_PX_PER_LOG_SCALE = 100;
export interface LookInputOptions {
  window: Window;
  controlTakesKey(target: EventTarget | null, key: string): boolean;
  createWheelGestureClassifier(options: { isSafariWithGestures: boolean; mode(): "auto" | "mouse" | "trackpad"; precedingWheelMs?: number }): (event: WheelEvent) => "ignore" | "pan" | "orbit" | "pinchZoom" | "wheelZoom";
  canvas: HTMLElement;
  model: LookModel;
  /** Escape and the controller's exit. */
  onExit(): void;
  /** Any look input: cancels an entry's expansion or an arrival's levelling. */
  onUserInput(): void;
  /** Something moved: a frame is needed, and while the model is `moving()`, its `step` on every frame. */
  requestFrame(): void;
  /** Whether a binding is being captured, which keeps input. */
  capturing?: () => boolean;
  /** How wheel events are read, as the globe reads them: the runtime's `input.mode`. */
  inputMode?: () => "auto" | "mouse" | "trackpad";
  /** Safari on macOS reports trackpad pinches as gesture events, and ctrl+wheel is not a pinch there. */
  safariGestures?: boolean;
  /** When the last wheel event came before looking began: a gesture under way then, such as a swipe's momentum over the globe, looks nowhere. */
  precedingWheelMs?: number;
}

/** Binds look input; returns the controller-intent handler and a detach function. */
export function attachLookInput(options: LookInputOptions): { applyIntents(frame: ActionIntentFrame): void; detach(): void } {
  const { canvas, model, window } = options;
  const pointers = new Map<number, { x: number; y: number; at: number }>();
  let pinchFrom: number | null = null;
  const keys = new Set<string>();
  const padRates = { lookX: 0, lookY: 0, zoom: 0 };
  const classifyWheel = options.createWheelGestureClassifier({
    isSafariWithGestures: options.safariGestures ?? false,
    mode: options.inputMode ?? (() => "auto"),
    precedingWheelMs: options.precedingWheelMs,
  });
  let gestureScale = 1;
  let attached = true;

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
    const last = pointers.get(event.pointerId);
    if (!last || !pointers.delete(event.pointerId)) return;
    pinchFrom = pointers.size === 2 ? separation() : null;
    if (pointers.size === 0) {
      model.release(event.timeStamp - last.at);
      if (model.moving()) options.requestFrame();
    }
  };
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const gesture = classifyWheel(event);
    if (gesture === "ignore") return;
    options.onUserInput();
    const scale = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? WHEEL_NOTCH_PX * 3 : 1;
    // A swipe, or shift+wheel, looks around: what pans or orbits the globe.
    if (gesture === "pan" || gesture === "orbit") model.swipe(event.deltaX * scale, event.deltaY * scale);
    else if (gesture === "pinchZoom") model.pinchBy((-event.deltaY * scale) / PINCH_WHEEL_PX_PER_LOG_SCALE);
    else model.wheel(event.deltaY * scale);
    options.requestFrame();
  };
  // Safari's trackpad pinch: `scale` is relative to the gesture's start.
  const onGestureStart = (event: Event): void => {
    event.preventDefault();
    gestureScale = 1;
  };
  const onGestureChange = (event: Event): void => {
    event.preventDefault();
    const next = (event as Event & { scale?: number }).scale;
    if (typeof next !== "number" || !(next > 0)) return;
    options.onUserInput();
    model.pinch(gestureScale, next);
    gestureScale = next;
    options.requestFrame();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    // A focused control keeps the keys it uses: a slider its arrows, a text field all of them.
    if (options.controlTakesKey(event.target, event.key) || options.capturing?.()) return;
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
    for (const id of pointers.keys()) { try { canvas.releasePointerCapture(id); } catch { /* released */ } }
    pointers.clear(); pinchFrom = null;
    padRates.lookX = padRates.lookY = padRates.zoom = 0;
    model.cancelInertia(); syncRates();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  if (options.safariGestures) {
    canvas.addEventListener("gesturestart", onGestureStart, { passive: false });
    canvas.addEventListener("gesturechange", onGestureChange, { passive: false });
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  return {
    applyIntents(frame) {
      if (!attached) return;
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
      if (!attached) return; attached = false;
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("gesturestart", onGestureStart);
      canvas.removeEventListener("gesturechange", onGestureChange);
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
