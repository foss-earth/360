/** Browser/input realm binding extracted from App/sceneWorld; never attaches on import. */
import { createWheelGestureClassifier, type NavigationLease } from "@foss-earth/engine";
import { isSafariGestureSupported, watchWheelGestures } from "@foss-earth/engine/browser";
import type { GlobeRuntime } from "@foss-earth/engine/babylon";
import { attachLookInput } from "./browserInput.js";
import type { ViewerHeldPress, ViewerInputPorts, ViewerNavigationLease } from "./viewer.js";

const attemptCleanup = (actions: readonly (() => void)[], message: string): void => {
  const errors: unknown[] = [];
  for (const action of actions) { try { action(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, message);
};
export function createGlobeViewerInput(
  runtime: Pick<GlobeRuntime, "getInputMode" | "setNavigationIntentHandler">, canvas: HTMLCanvasElement,
  engineLeaseFor: (lease: ViewerNavigationLease) => NavigationLease, ports: {
    nowMs(): number; controlTakesKey: Parameters<typeof attachLookInput>[0]["controlTakesKey"];
    abortReason(): unknown; signal?: AbortSignal; onRetirementError?(error: unknown): void;
  },
) {
  let disposed = false;
  const cleanupErrors: unknown[] = [];
  const releases = new Set<() => void>();
  const current = (): void => { if (disposed) throw new Error("The viewer input binding has retired."); };
  const nowMs = () => ports.nowMs();
  const hostWindow = canvas.ownerDocument.defaultView;
  if (!hostWindow) throw new Error("Scene input needs the canvas Window.");
  const wheels = watchWheelGestures(canvas, { window: hostWindow, nowMs });
  const input: ViewerInputPorts = {
    attach({ model, lease, requestFrame, userInput, exit }) {
      current();
      const look = attachLookInput({
        window: hostWindow, canvas, model, controlTakesKey: ports.controlTakesKey,
        createWheelGestureClassifier: options => createWheelGestureClassifier({ ...options, nowMs }),
        onExit: exit, onUserInput: userInput, requestFrame,
        inputMode: () => { const mode = runtime.getInputMode(); return mode === "touch" ? "auto" : mode; },
        safariGestures: isSafariGestureSupported({ userAgent: hostWindow.navigator.userAgent, hasGestureEvent: "GestureEvent" in hostWindow }),
        precedingWheelMs: wheels.lastEventMs(),
      });
      let off: () => void;
      try { off = runtime.setNavigationIntentHandler(engineLeaseFor(lease), frame => look.applyIntents(frame)); }
      catch (error) {
        try { look.detach(); }
        catch (release) { throw new AggregateError([error, release], "Scene input attachment failed."); }
        throw error;
      }
      let detached = false;
      const detach = (): void => {
        if (detached) return;
        detached = true;
        const errors: unknown[] = [];
        try { off(); } catch (error) { errors.push(error); }
        try { look.detach(); } catch (error) { errors.push(error); }
        releases.delete(detach);
        if (errors.length) throw new AggregateError(errors, "Scene look input cleanup failed.");
      };
      releases.add(detach);
      return { detach };
    },
    cancelOnInput(controller) {
      current();
      let held: ViewerHeldPress | null = null;
      const cancel = () => controller.abort(ports.abortReason());
      const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } };
      const onPress = (event: PointerEvent) => {
        if (event.pointerType === "mouse") held = { pointerId: event.pointerId, button: event.button, clientX: event.clientX, clientY: event.clientY };
        cancel();
      };
      const onWheel = () => { if (wheels.begins()) cancel(); };
      let stopped = false;
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        releases.delete(stop);
        attemptCleanup([
          () => hostWindow.removeEventListener("keydown", onKey),
          () => canvas.removeEventListener("pointerdown", onPress),
          () => canvas.removeEventListener("wheel", onWheel),
        ], "Scene input cancellation cleanup failed.");
      };
      try {
        hostWindow.addEventListener("keydown", onKey);
        canvas.addEventListener("pointerdown", onPress);
        canvas.addEventListener("wheel", onWheel, { passive: true });
      } catch (error) {
        try { stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Viewer input setup failed."); }
        throw error;
      }
      releases.add(stop);
      return { press: () => held, stop };
    },
  };
  const dispose = (): void => {
    if (!disposed) {
      disposed = true;
      try { attemptCleanup([() => ports.signal?.removeEventListener("abort", abort), ...releases, () => wheels.dispose()], "Viewer input retirement failed."); }
      catch (error) { cleanupErrors.push(error); } finally { releases.clear(); }
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Viewer input retirement failed.");
  };
  const abort = (): void => { try { dispose(); } catch (error) {
    try { ports.onRetirementError?.(error); } catch (reporting) { cleanupErrors.push(reporting); }
  } };
  ports.signal?.addEventListener("abort", abort, { once: true });
  if (ports.signal?.aborted) abort();
  return { input, wheels, dispose };
}
