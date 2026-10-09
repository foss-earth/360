import { describe, expect, it } from "vitest";
import { createLookModel, zoomFov, type LookSettings } from "../src/look.js";
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

