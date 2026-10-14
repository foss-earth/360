import { describe, expect, it } from "vitest";
import { zoomRectangleCamera } from "../src/rectangleCamera.js";
import {
  fitRectangleSurface,
  rectangleSurfacePresentation,
  rectangleWipeSide,
  initialRectangleSurfaceState,
  presentRectangleSurface,
  resizeRectangleSurface,
  setRectangleWipe,
  withRectangleCamera,
  type RectangleSlotDocument,
} from "../src/rectangleSession.js";

const doc = (id: string, width: number | null, height = width === null ? 0 : Math.round(width * 9 / 16)): RectangleSlotDocument => ({
  tabId: `tab-${id}`, documentId: id, revision: "1", title: id, size: width === null ? null : { width, height },
});
const full = doc("full", 1920, 1080), half = doc("half", 960, 540), square = doc("square", 800, 800);
const viewport = { width: 1000, height: 600 };

describe("rectangle surface presentation", () => {
  it("follows the participation table", () => {
    expect(rectangleSurfacePresentation(null, null)).toEqual({ kind: "none" });
    expect(rectangleSurfacePresentation(full, null)).toEqual({ kind: "single", side: "left", document: full });
    expect(rectangleSurfacePresentation(null, half)).toEqual({ kind: "single", side: "right", document: half });
    expect(rectangleSurfacePresentation(full, half).kind).toBe("pair");
    // Two instances of the same asset compare too.
    expect(rectangleSurfacePresentation(full, { ...full, tabId: "tab-other" }).kind).toBe("pair");
    const incompatible = rectangleSurfacePresentation(full, square);
    expect(incompatible.kind).toBe("incompatible");
    if (incompatible.kind === "incompatible") expect(incompatible.reason).toContain("1920 × 1080");
  });

  it("does not round odd half-resolution sizes into a match", () => {
    expect(rectangleSurfacePresentation(doc("a", 1921, 1081), doc("b", 960, 540)).kind).toBe("incompatible");
  });

  it("presents a pair while one size is still unknown", () => {
    expect(rectangleSurfacePresentation(full, doc("pending", null)).kind).toBe("pair");
  });
});

describe("rectangle surface session", () => {
  it("fits the first displayed image and keeps that extent and camera across compatible changes and swaps", () => {
    let state = presentRectangleSurface(initialRectangleSurfaceState(viewport), rectangleSurfacePresentation(half, null));
    expect(state.extent).toEqual({ width: 960, height: 540 });
    state = withRectangleCamera(state, zoomRectangleCamera(state.camera!, { x: 100, y: 100 }, 3, { min: 0.01, max: 100 }));
    const camera = state.camera;
    for (const [left, right] of [[half, full], [full, half], [null, full], [full, { ...full, tabId: "tab-again" }]] as const) {
      state = presentRectangleSurface(state, rectangleSurfacePresentation(left, right));
      expect(state.camera).toBe(camera);
      expect(state.extent).toEqual({ width: 960, height: 540 });
    }
  });

  it("waits for a size before creating a camera", () => {
    const state = presentRectangleSurface(initialRectangleSurfaceState(viewport), rectangleSurfacePresentation(doc("pending", null), null));
    expect(state.camera).toBeNull();
    expect(presentRectangleSurface(state, rectangleSurfacePresentation({ ...doc("pending", null), size: { width: 400, height: 300 } }, null)).camera).not.toBeNull();
  });

  it("fits an incompatible newcomer, and restores the old document's view when it returns", () => {
    let state = presentRectangleSurface(initialRectangleSurfaceState(viewport), rectangleSurfacePresentation(full, null));
    state = withRectangleCamera(state, zoomRectangleCamera(state.camera!, { x: 10, y: 20 }, 2, { min: 0.01, max: 100 }));
    const zoomed = state.camera;
    state = presentRectangleSurface(state, rectangleSurfacePresentation(square, null));
    expect(state.extent).toEqual({ width: 800, height: 800 });
    expect(state.camera!.scale).toBeCloseTo(600 / 800, 12);
    state = presentRectangleSurface(state, rectangleSurfacePresentation(full, null));
    expect(state.camera).toEqual(zoomed);
    expect(state.extent).toEqual({ width: 1920, height: 1080 });
  });

  it("keeps the camera through wipe changes, and clamps the wipe", () => {
    const state = presentRectangleSurface(initialRectangleSurfaceState(viewport), rectangleSurfacePresentation(full, half));
    const camera = state.camera;
    expect(setRectangleWipe(state, 0.2).camera).toBe(camera);
    expect(setRectangleWipe(state, 3).wipe).toBe(1);
    expect(setRectangleWipe(state, -1).wipe).toBe(0);
  });

  it("resizes around the centre, and fits only on command", () => {
    let state = presentRectangleSurface(initialRectangleSurfaceState(viewport), rectangleSurfacePresentation(full, null));
    state = withRectangleCamera(state, zoomRectangleCamera(state.camera!, { x: 0, y: 0 }, 1.5, { min: 0.01, max: 100 }));
    const resized = resizeRectangleSurface(state, { width: 500, height: 600 });
    expect(resized.camera!.scale).toBe(1.5);
    expect(fitRectangleSurface(resized).camera!.scale).toBeCloseTo(500 / 1920, 12);
  });

  it("chooses left below the wipe and right at or above it", () => {
    expect(rectangleWipeSide(0, 100, 0)).toBe("right");
    expect(rectangleWipeSide(99.5, 100, 1)).toBe("left");
    expect(rectangleWipeSide(49.5, 100, 0.5)).toBe("left");
    expect(rectangleWipeSide(50.5, 100, 0.5)).toBe("right");
  });
});
