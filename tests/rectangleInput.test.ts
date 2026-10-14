// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { controlTakesKey } from "@felipegalind0/gamepad-tools/browser";
import { createWheelGestureClassifier as createEngineWheelGestureClassifier } from "@foss-earth/engine/core";
import { attachLookInput, createWheelGestureRouter } from "../src/browserInput.js";
import { createRectangleCameraTarget, RECTANGLE_ZOOM_PER_NOTCH } from "../src/cameraTarget.js";
import { fitRectangleCamera, rectangleLocalPointOf, rectanglePlanePointAt, type RectangleCamera } from "../src/rectangleCamera.js";

const extent = { width: 1920, height: 1080 };
const viewport = { width: 800, height: 600 };
const limits = { min: 0.01, max: 100 };

function rectangleTarget() {
  let camera: RectangleCamera | null = fitRectangleCamera(extent, viewport);
  const target = createRectangleCameraTarget({ get: () => camera, set: next => { camera = next; }, viewport: () => viewport, limits: () => limits });
  return { target, camera: () => camera!, clear: () => { camera = null; } };
}

describe("rectangle camera target", () => {
  it("zooms a wheel notch at the pointer, keeping the plane point under it", () => {
    const { target, camera } = rectangleTarget();
    const at = { x: 123.5, y: 456.25 };
    const plane = rectanglePlanePointAt(camera(), at);
    const before = camera().scale;
    target.wheel(-100, at);
    expect(camera().scale).toBeCloseTo(before * Math.exp(RECTANGLE_ZOOM_PER_NOTCH), 12);
    const back = rectangleLocalPointOf(camera(), plane);
    expect(Math.abs(back.x - at.x)).toBeLessThan(0.25);
    expect(Math.abs(back.y - at.y)).toBeLessThan(0.25);
  });

  it("anchors a pinch without a point at the centre", () => {
    const { target, camera } = rectangleTarget();
    const plane = rectanglePlanePointAt(camera(), { x: 400, y: 300 });
    target.pinchBy(Math.log(2), null);
    const back = rectangleLocalPointOf(camera(), plane);
    expect(back.x).toBeCloseTo(400, 9);
    expect(back.y).toBeCloseTo(300, 9);
  });

  it("pans a swipe on both axes against its deltas, and a drag with them", () => {
    const { target, camera } = rectangleTarget();
    const start = camera();
    target.swipe(10, -4);
    expect(camera()).toMatchObject({ x: start.x - 10, y: start.y + 4, scale: start.scale });
    target.drag(3, 5, 16);
    expect(camera()).toMatchObject({ x: start.x - 7, y: start.y + 9 });
  });

  it("moves the touch midpoint and scales by the separation in one update", () => {
    const { target, camera } = rectangleTarget();
    const from = { mid: { x: 200, y: 200 }, separation: 100 }, to = { mid: { x: 260, y: 180 }, separation: 150 };
    const plane = rectanglePlanePointAt(camera(), from.mid);
    const before = camera().scale;
    target.touchPinch(from, to);
    expect(camera().scale).toBeCloseTo(before * 1.5, 12);
    const back = rectangleLocalPointOf(camera(), plane);
    expect(back.x).toBeCloseTo(260, 9);
    expect(back.y).toBeCloseTo(180, 9);
  });

  it("steps held rates, zooming at the centre, and stops when they are released", () => {
    const { target, camera } = rectangleTarget();
    target.setRates({ lookX: 1, lookY: 0, zoom: 0 });
    const x = camera().x;
    expect(target.step(100)).toBe(true);
    expect(camera().x).toBeCloseTo(x - 60, 9);
    target.setRates({ lookX: 0, lookY: 0, zoom: 1 });
    const plane = rectanglePlanePointAt(camera(), { x: 400, y: 300 });
    target.step(100);
    expect(rectangleLocalPointOf(camera(), plane).x).toBeCloseTo(400, 9);
    target.setRates({ lookX: 0, lookY: 0, zoom: 0 });
    expect(target.step(16)).toBe(false);
    expect(target.moving()).toBe(false);
  });

  it("does nothing without a camera", () => {
    const { target, clear } = rectangleTarget();
    clear();
    expect(() => { target.wheel(-100, null); target.drag(1, 1, 1); target.swipe(1, 1); }).not.toThrow();
  });
});

const createWheelGestureClassifier: Parameters<typeof attachLookInput>[0]["createWheelGestureClassifier"] = options =>
  createEngineWheelGestureClassifier({ ...options, nowMs: () => performance.now() });

describe("routed image input", () => {
  function setup() {
    let now = 1000;
    const router = createWheelGestureRouter({ window, nowMs: () => now });
    const surface = document.createElement("div"), other = document.createElement("div");
    document.body.append(surface, other);
    surface.getBoundingClientRect = () => ({ left: 50, top: 20, right: 850, bottom: 620, width: 800, height: 600, x: 50, y: 20, toJSON() {} });
    const { target, camera } = rectangleTarget();
    const requestFrame = vi.fn();
    const binding = attachLookInput({
      window, canvas: surface, model: target, router, controlTakesKey, createWheelGestureClassifier,
      localPoint: (x, y) => ({ x: x - 50, y: y - 20 }),
      onExit() {}, onUserInput() {}, requestFrame, inputMode: () => "mouse",
    });
    const otherWheel = vi.fn();
    other.addEventListener("wheel", otherWheel);
    const wheel = (target: Element, deltaY: number, clientX = 450, clientY = 320) => {
      const event = new WheelEvent("wheel", { deltaY, clientX, clientY, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    };
    return { router, surface, other, camera, binding, otherWheel, wheel, advance: (ms: number) => { now += ms; } };
  }

  it("keeps a wheel gesture with the surface it began over, wherever it goes, and away from the page", () => {
    const { router, surface, other, camera, otherWheel, wheel, advance, binding } = setup();
    const scale = camera().scale;
    const first = wheel(surface, -100);
    expect(first.defaultPrevented).toBe(true);
    expect(camera().scale).toBeGreaterThan(scale);
    advance(50);
    const scaled = camera().scale;
    wheel(other, -100);
    expect(otherWheel).not.toHaveBeenCalled();
    expect(camera().scale).toBeGreaterThan(scaled);
    // A fresh gesture over the page is the page's, even over the surface later.
    advance(500);
    wheel(other, -100);
    expect(otherWheel).toHaveBeenCalledTimes(1);
    const kept = camera().scale;
    advance(50);
    const passed = wheel(surface, -100);
    expect(camera().scale).toBe(kept);
    expect(passed.defaultPrevented).toBe(false);
    binding.detach();
    router.dispose();
  });

  it("zooms at the wheel's own point, in surface-local pixels", () => {
    const { router, surface, camera, wheel, binding } = setup();
    const plane = rectanglePlanePointAt(camera(), { x: 100, y: 50 });
    wheel(surface, -100, 150, 70);
    const back = rectangleLocalPointOf(camera(), plane);
    expect(back.x).toBeCloseTo(100, 6);
    expect(back.y).toBeCloseTo(50, 6);
    binding.detach();
    router.dispose();
  });

  it("drops the rest of a cancelled gesture instead of handing it to anyone", () => {
    const { router, surface, other, camera, otherWheel, wheel, advance, binding } = setup();
    wheel(surface, -100);
    binding.cancel();
    const scale = camera().scale;
    advance(50);
    expect(wheel(surface, -100).defaultPrevented).toBe(true);
    advance(50);
    wheel(other, -100);
    expect(otherWheel).not.toHaveBeenCalled();
    expect(camera().scale).toBe(scale);
    advance(500);
    wheel(surface, -100);
    expect(camera().scale).toBeGreaterThan(scale);
    binding.detach();
    router.dispose();
  });

  it("leaves the keys to the binding that owns them", () => {
    const { router, surface } = setup();
    const { target, camera } = rectangleTarget();
    let owns = false;
    const binding = attachLookInput({
      window, canvas: surface, model: target, router, controlTakesKey, createWheelGestureClassifier,
      ownsKeys: () => owns, onExit() {}, onUserInput() {}, requestFrame() {},
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(target.moving()).toBe(false);
    owns = true;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(target.moving()).toBe(true);
    const x = camera().x;
    target.step(100);
    expect(camera().x).toBeLessThan(x);
    window.dispatchEvent(new Event("blur"));
    expect(target.moving()).toBe(false);
    binding.detach();
    router.dispose();
  });
});
