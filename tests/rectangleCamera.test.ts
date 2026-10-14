import { describe, expect, it } from "vitest";
import {
  fitRectangleCamera,
  rectangleLocalPointOf,
  rectangleNativeStatus,
  rectanglePlanePointAt,
  rectangleScaleLimits,
  nativeRectangleCamera,
  panRectangleCamera,
  pinchRectangleCamera,
  resizeRectangleCamera,
  zoomRectangleCamera,
  type RectangleCamera,
} from "../src/rectangleCamera.js";

const extent = { width: 1920, height: 1080 };
const viewport = { width: 1000, height: 700 };
const wide = { min: 1e-3, max: 1e3 };

describe("rectangle camera", () => {
  it("fits the whole plane, centred, preserving its aspect", () => {
    const camera = fitRectangleCamera(extent, viewport);
    expect(camera.scale).toBeCloseTo(1000 / 1920, 12);
    expect(rectangleLocalPointOf(camera, { x: 0, y: 0 }).x).toBeCloseTo(0, 9);
    expect(rectangleLocalPointOf(camera, { x: 960, y: 540 })).toEqual({ x: 500, y: 350 });
  });

  it("keeps the plane point under an off-centre anchor through zoom, including clamped steps", () => {
    const limits = { min: 0.2, max: 4 };
    let camera: RectangleCamera = fitRectangleCamera(extent, viewport);
    const anchor = { x: 137.25, y: 611.5 };
    const plane = rectanglePlanePointAt(camera, anchor);
    for (const factor of [1.7, 3, 9, 50, 0.01, 0.4, 2.5]) {
      camera = zoomRectangleCamera(camera, anchor, camera.scale * factor, limits);
      expect(camera.scale).toBeGreaterThanOrEqual(limits.min);
      expect(camera.scale).toBeLessThanOrEqual(limits.max);
      const back = rectangleLocalPointOf(camera, plane);
      expect(Math.abs(back.x - anchor.x)).toBeLessThan(0.25);
      expect(Math.abs(back.y - anchor.y)).toBeLessThan(0.25);
    }
  });

  it("does not recentre the plane after a zoom out past its edges", () => {
    const camera = zoomRectangleCamera(fitRectangleCamera(extent, viewport), { x: 10, y: 10 }, 0.05, wide);
    expect(rectangleLocalPointOf(camera, rectanglePlanePointAt(camera, { x: 10, y: 10 }))).toEqual({ x: 10, y: 10 });
    expect(camera.x).toBeGreaterThan(0);
  });

  it("pans on both axes", () => {
    expect(panRectangleCamera({ scale: 2, x: 5, y: 6 }, -3, 4)).toEqual({ scale: 2, x: 2, y: 10 });
  });

  it("pinches with separation and midpoint motion in one update", () => {
    const camera = fitRectangleCamera(extent, viewport);
    const from = { x: 300, y: 200 }, to = { x: 340, y: 260 };
    const plane = rectanglePlanePointAt(camera, from);
    const next = pinchRectangleCamera(camera, from, to, 1.5, wide);
    expect(next.scale).toBeCloseTo(camera.scale * 1.5, 12);
    const at = rectangleLocalPointOf(next, plane);
    expect(at.x).toBeCloseTo(to.x, 9);
    expect(at.y).toBeCloseTo(to.y, 9);
  });

  it("keeps the scale and the centre's plane point when the surface resizes", () => {
    const camera = zoomRectangleCamera(fitRectangleCamera(extent, viewport), { x: 200, y: 100 }, 1.3, wide);
    const centre = rectanglePlanePointAt(camera, { x: 500, y: 350 });
    const resized = resizeRectangleCamera(camera, viewport, { width: 640, height: 900 });
    expect(resized.scale).toBe(camera.scale);
    const at = rectanglePlanePointAt(resized, { x: 320, y: 450 });
    expect(at.x).toBeCloseTo(centre.x, 9);
    expect(at.y).toBeCloseTo(centre.y, 9);
  });

  it("bounds the scale between a small fraction of a fit and deep magnification of the densest source", () => {
    const limits = rectangleScaleLimits(extent, viewport, { width: 1920, pixelsPerCss: 2 });
    expect(limits.min).toBeCloseTo(1000 / 1920 / 20, 12);
    expect(limits.max).toBeCloseTo(64 / 2, 12);
  });
});

describe("native-pixel inspection", () => {
  // A half-resolution input registered on a full-resolution extent.
  const half = { width: 960, height: 540 };

  for (const ratio of [1, 2, 1.5, 1.25]) it(`puts one texel of the named source on one framebuffer pixel, centred, at ${ratio} pixels per CSS pixel`, () => {
    const start = zoomRectangleCamera(fitRectangleCamera(extent, viewport), { x: 333.3, y: 222.2 }, 0.77, wide);
    const result = nativeRectangleCamera(start, extent, half, { x: ratio, y: ratio }, viewport);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const camera = result.camera;
    expect(camera.scale).toBeCloseTo(960 / (1920 * ratio), 12);
    expect(rectangleNativeStatus(camera, extent, half, { x: ratio, y: ratio })).toEqual({ scale: true, aligned: true });
    // Every texel centre of the source lands on a framebuffer pixel centre: k + ½.
    for (const i of [0, 1, 17, 480, 959]) {
      const planeX = (i + 0.5) * extent.width / half.width;
      const framebufferX = rectangleLocalPointOf(camera, { x: planeX, y: 0 }).x * ratio;
      expect(Math.abs(framebufferX - Math.floor(framebufferX) - 0.5)).toBeLessThan(1e-6);
      // And neighbours are one pixel apart.
      const next = rectangleLocalPointOf(camera, { x: planeX + extent.width / half.width, y: 0 }).x * ratio;
      expect(next - framebufferX).toBeCloseTo(1, 9);
    }
    // The centre moved by less than one framebuffer pixel's worth of plane.
    const before = rectanglePlanePointAt(zoomRectangleCamera(start, { x: 500, y: 350 }, camera.scale, wide), { x: 500, y: 350 });
    const after = rectanglePlanePointAt(camera, { x: 500, y: 350 });
    expect(Math.abs(after.x - before.x) * camera.scale * ratio).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it("reports free motion that leaves the alignment, and the scale it keeps", () => {
    const result = nativeRectangleCamera(fitRectangleCamera(extent, viewport), extent, extent, { x: 2, y: 2 }, viewport);
    if (!result.ok) throw new Error(result.reason);
    expect(rectangleNativeStatus(panRectangleCamera(result.camera, 0.25, 0), extent, extent, { x: 2, y: 2 })).toEqual({ scale: true, aligned: false });
    expect(rectangleNativeStatus(panRectangleCamera(result.camera, 0.5, 1), extent, extent, { x: 2, y: 2 })).toEqual({ scale: true, aligned: true });
    expect(rectangleNativeStatus(zoomRectangleCamera(result.camera, { x: 1, y: 1 }, result.camera.scale * 1.01, wide), extent, extent, { x: 2, y: 2 }).scale).toBe(false);
  });

  it("refuses an anisotropic surface or a source of another aspect", () => {
    const camera = fitRectangleCamera(extent, viewport);
    const anisotropic = nativeRectangleCamera(camera, extent, extent, { x: 2, y: 1.98 }, viewport);
    expect(anisotropic.ok).toBe(false);
    expect(nativeRectangleCamera(camera, extent, { width: 961, height: 540 }, { x: 1, y: 1 }, viewport).ok).toBe(false);
  });
});
