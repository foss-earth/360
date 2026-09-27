// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { attachLookInput, createLookModel, zoomFov, type LookSettings } from "./panoramaInput";

const SETTINGS: LookSettings = {
  dragSensitivity: 0.15, swipeSensitivity: 0.1, lookRate: 90, zoomPerNotch: 0.1, zoomRate: 0.5, pinchGain: 1, inertiaHalfLifeMs: 100,
  fovRangeDeg: { min: 35, max: 90 }, pitchRangeDeg: { min: -85, max: 85 }, reducedMotion: false,
};

describe("panorama look model", () => {
  it("looks left when the image is dragged right, and up when it is dragged down", () => {
    const model = createLookModel({ headingDeg: 10, pitchDeg: 0, verticalFovDeg: 60 }, () => SETTINGS, () => {});
    model.drag(100, 0, 16);
    expect(model.get().headingDeg).toBeCloseTo(355);
    model.drag(0, 100, 16);
    expect(model.get().pitchDeg).toBeCloseTo(15);
  });

  it("narrows the view for wheel up and pinch out, on tan(fov/2), within its range", () => {
    const model = createLookModel({ headingDeg: 0, pitchDeg: 0, verticalFovDeg: 60 }, () => SETTINGS, () => {});
    model.wheel(-100);
    expect(model.get().verticalFovDeg).toBeCloseTo(zoomFov(60, 0.1));
    expect(model.get().verticalFovDeg).toBeLessThan(60);
    model.pinch(100, 200);
    expect(model.get().verticalFovDeg).toBe(35);
    for (let i = 0; i < 100; i++) model.wheel(100);
    expect(model.get().verticalFovDeg).toBe(90);
  });

  it("moves the image with a swipe as a drag does: scrolling right looks right, scrolling down looks down", () => {
    const model = createLookModel({ headingDeg: 10, pitchDeg: 0, verticalFovDeg: 60 }, () => SETTINGS, () => {});
    model.swipe(100, 0);
    expect(model.get().headingDeg).toBeCloseTo(20);
    model.swipe(0, 100);
    expect(model.get().pitchDeg).toBeCloseTo(-10);
    // The OS adds momentum after the fingers lift; the model adds none.
    expect(model.moving()).toBe(false);
  });

  it("clamps pitch to its range and keeps heading in [0, 360)", () => {
    const model = createLookModel({ headingDeg: 359, pitchDeg: 80, verticalFovDeg: 60 }, () => SETTINGS, () => {});
    model.drag(-20, 200, 16);
    expect(model.get().pitchDeg).toBe(85);
    expect(model.get().headingDeg).toBeCloseTo(2);
  });

  it("turns at the look rate while a key or stick is held, and stops when released", () => {
    const model = createLookModel({ headingDeg: 0, pitchDeg: 0, verticalFovDeg: 60 }, () => SETTINGS, () => {});
    model.setRates({ lookX: 1, lookY: 0, zoom: 0 });
    expect(model.step(100)).toBe(true);
    expect(model.get().headingDeg).toBeCloseTo(9);
    model.setRates({ lookX: 0, lookY: 0, zoom: 0 });
    expect(model.step(100)).toBe(false);
  });

  it("keeps a drag's speed for its release, and drops it when the drag was held still first", () => {
    const model = createLookModel({ headingDeg: 180, pitchDeg: 0, verticalFovDeg: 60 }, () => SETTINGS, () => {});
    model.drag(-10, 0, 10);
    expect(model.moving()).toBe(false);
    expect(model.step(16)).toBe(false);
    expect(model.get().headingDeg).toBeCloseTo(181.5);
    model.release(200);
    expect(model.moving()).toBe(false);
    model.drag(-10, 0, 10);
    model.release(10);
    expect(model.moving()).toBe(true);
  });

  it("continues a flick with a half-life, and not at all with reduced motion or a zero half-life", () => {
    const flick = (settings: LookSettings) => {
      const model = createLookModel({ headingDeg: 180, pitchDeg: 0, verticalFovDeg: 60 }, () => settings, () => {});
      model.drag(-10, 0, 10);
      model.release();
      const after = model.get().headingDeg;
      model.step(100);
      return { moved: model.get().headingDeg - after, moving: model.moving() };
    };
    const normal = flick(SETTINGS);
    expect(normal.moved).toBeGreaterThan(0);
    expect(flick({ ...SETTINGS, reducedMotion: true })).toEqual({ moved: 0, moving: false });
    expect(flick({ ...SETTINGS, inertiaHalfLifeMs: 0 })).toEqual({ moved: 0, moving: false });
  });
});

describe("panorama look input", () => {
  it("exits on Escape but not while typing, and sends controller look and exit to the model", () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const onExit = vi.fn();
    const model = createLookModel({ headingDeg: 0, pitchDeg: 0, verticalFovDeg: 60 }, () => SETTINGS, () => {});
    const input = attachLookInput({ canvas, model, onExit, onUserInput: vi.fn(), requestFrame: vi.fn() });
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
});

describe("panorama wheel input", () => {
  const wheel = (init: WheelEventInit) => new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  const attach = (mode: "trackpad" | "mouse") => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const model = createLookModel({ headingDeg: 90, pitchDeg: 0, verticalFovDeg: 60 }, () => SETTINGS, () => {});
    const input = attachLookInput({ canvas, model, onExit: vi.fn(), onUserInput: vi.fn(), requestFrame: vi.fn(), inputMode: () => mode });
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
