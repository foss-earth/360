// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { attachLookInput } from "../src/browserInput.js";
import { createLookModel, zoomFov, type LookSettings } from "../src/index.js";
import { controlTakesKey } from "@felipegalind0/gamepad-tools/browser";
import { createWheelGestureClassifier } from "@foss-earth/engine/core";

const SETTINGS: LookSettings = {
  dragSensitivity: 0.15, swipeSensitivity: 0.1, lookRate: 90, zoomPerNotch: 0.1, zoomRate: 0.5, pinchGain: 1, inertiaHalfLifeMs: 100,
  fovRangeDeg: { min: 35, max: 90 }, pitchRangeDeg: { min: -85, max: 85 }, reducedMotion: false,
};

describe("panorama look input", () => {
  it("exits on Escape but not while typing, and sends controller look and exit to the model", () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const onExit = vi.fn();
    const model = createLookModel({ headingDeg: 0, pitchDeg: 0, verticalFovDeg: 60 }, () => SETTINGS, () => {});
    const input = attachLookInput({ canvas, model, window, controlTakesKey, createWheelGestureClassifier, onExit, onUserInput: vi.fn(), requestFrame: vi.fn() });
    const field = document.createElement("input");
    document.body.append(field);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onExit).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onExit).toHaveBeenCalledTimes(1);
    input.applyIntents({ dt: 0.1, intents: [
      { kind: "rate", actionId: "panorama.lookX", value: 1, dt: 0.1 },
      { kind: "command", actionId: "panorama.exit", edge: "press" },
    ] } as never);
    expect(onExit).toHaveBeenCalledTimes(2);
    expect(model.moving()).toBe(true);
    input.detach();
    expect(model.moving()).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onExit).toHaveBeenCalledTimes(2);
  });

  it("leaves a focused slider its arrow keys, and the rest to the panorama", () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const onExit = vi.fn();
    const model = createLookModel({ headingDeg: 0, pitchDeg: 0, verticalFovDeg: 60 }, () => SETTINGS, () => {});
    const input = attachLookInput({ canvas, model, window, controlTakesKey, createWheelGestureClassifier, onExit, onUserInput: vi.fn(), requestFrame: vi.fn() });
    const slider = document.createElement("input");
    slider.type = "range";
    document.body.append(slider);
    // The arrow moves the slider's thumb, and only that.
    slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(model.moving()).toBe(false);
    slider.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
    // A slider has no use for Escape: it still leaves the panorama.
    slider.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onExit).toHaveBeenCalledTimes(1);
    // A button keeps Space and Enter, so the arrows look.
    const button = document.createElement("button");
    document.body.append(button);
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(model.moving()).toBe(true);
    input.detach();
  });
});

describe("panorama wheel input", () => {
  const wheel = (init: WheelEventInit) => new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  const attach = (mode: "trackpad" | "mouse") => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const model = createLookModel({ headingDeg: 90, pitchDeg: 0, verticalFovDeg: 60 }, () => SETTINGS, () => {});
    const input = attachLookInput({ canvas, model, window, controlTakesKey, createWheelGestureClassifier, onExit: vi.fn(), onUserInput: vi.fn(), requestFrame: vi.fn(), inputMode: () => mode });
    return { canvas, model, input };
  };

  it("in trackpad mode looks around with a two-finger swipe, and zooms with a pinch", () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const { canvas, model, input } = attach("trackpad");
    canvas.dispatchEvent(wheel({ deltaX: 30, deltaY: -20 }));
    expect(model.get().headingDeg).toBeCloseTo(93);
    expect(model.get().pitchDeg).toBeCloseTo(2);
    expect(model.get().verticalFovDeg).toBe(60);
    // A pause ends the swipe; the pinch that follows is its own gesture.
    vi.spyOn(performance, "now").mockReturnValue(2_000);
    canvas.dispatchEvent(wheel({ deltaY: -10, ctrlKey: true }));
    expect(model.get().verticalFovDeg).toBeCloseTo(zoomFov(60, 0.1));
    expect(model.get().headingDeg).toBeCloseTo(93);
    input.detach();
    vi.restoreAllMocks();
  });

  it("in mouse mode zooms with the wheel, as before", () => {
    const { canvas, model, input } = attach("mouse");
    canvas.dispatchEvent(wheel({ deltaY: -100 }));
    expect(model.get().verticalFovDeg).toBeCloseTo(zoomFov(60, 0.1));
    expect(model.get().headingDeg).toBe(90);
    input.detach();
  });
});

describe("detached input lifecycle", () => {
  it("releases pointer capture once and ignores late controller frames", () => {
    const canvas = document.createElement("canvas");
    canvas.setPointerCapture = vi.fn(); canvas.releasePointerCapture = vi.fn();
    const model = createLookModel({ headingDeg: 0, pitchDeg: 0, verticalFovDeg: 60 }, () => SETTINGS, () => {});
    const onExit = vi.fn(), onUserInput = vi.fn(), requestFrame = vi.fn();
    const binding = attachLookInput({ canvas, model, window, controlTakesKey, createWheelGestureClassifier, onExit, onUserInput, requestFrame });
    const down = new Event("pointerdown", { cancelable: true });
    Object.assign(down, { pointerId: 42, pointerType: "touch", button: 0, clientX: 10, clientY: 20 });
    canvas.dispatchEvent(down);
    binding.detach(); binding.detach();
    expect(canvas.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(42);
    const calls = onUserInput.mock.calls.length;
    binding.applyIntents({ dt: .1, intents: [ { kind: "rate", actionId: "panorama.lookX", value: 1, dt: .1 }, { kind: "command", actionId: "panorama.exit", edge: "press" } ] } as never);
    expect(model.moving()).toBe(false); expect(onExit).not.toHaveBeenCalled(); expect(onUserInput).toHaveBeenCalledTimes(calls);
  });
});
