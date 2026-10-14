import { describe, expect, it } from "vitest";
import { createSphereCameraTarget } from "../src/cameraTarget.js";
import { createLookModel, zoomFov, type LookSettings } from "../src/look.js";
import { projectSphereRay, sphereRay, type SphereCamera } from "../src/sphereCamera.js";

const settings: LookSettings = {
  dragSensitivity: 0.15, swipeSensitivity: 0.1, lookRate: 90, zoomPerNotch: 0.1, zoomRate: 0.5, pinchGain: 1, inertiaHalfLifeMs: 0,
  fovRangeDeg: { min: 10, max: 120 }, pitchRangeDeg: { min: -85, max: 85 }, reducedMotion: true,
};
const viewport = { width: 800, height: 600 };
const start: SphereCamera = { headingDeg: 30, pitchDeg: 8, verticalFovDeg: 70 };

function errorAt(camera: SphereCamera, ray: readonly [number, number, number], point: { x: number; y: number }): number {
  const projected = projectSphereRay(camera, viewport, ray);
  if (!projected) return Infinity;
  return Math.hypot(projected.x - point.x, projected.y - point.y);
}

describe("shared sphere look", () => {
  it("keeps a centre wheel on the old field of view, and an off-centre wheel on the ray under the pointer", () => {
    let state = start;
    const model = createLookModel(start, () => settings, next => { state = next; }, () => viewport);
    model.wheel(-100, { x: 400, y: 300 });
    expect(state.headingDeg).toBeCloseTo(start.headingDeg, 6);
    expect(state.pitchDeg).toBeCloseTo(start.pitchDeg, 6);
    expect(state.verticalFovDeg).toBeCloseTo(zoomFov(70, settings.zoomPerNotch), 6);

    const at = { x: 620, y: 180 };
    const ray = sphereRay(state, viewport, at);
    model.wheel(-100, at);
    expect(errorAt(state, ray, at)).toBeLessThan(0.25);
    expect(state.verticalFovDeg).toBeLessThan(70);
  });

  it("moves a two-finger pinch's midpoint and separation as one update", () => {
    let state = start;
    const model = createLookModel(start, () => settings, next => { state = next; }, () => viewport);
    const from = { mid: { x: 300, y: 280 }, separation: 80 };
    const to = { mid: { x: 360, y: 240 }, separation: 140 };
    const ray = sphereRay(start, viewport, from.mid);
    model.touchPinch(from, to);
    expect(state.verticalFovDeg).toBeCloseTo(zoomFov(70, Math.log(140 / 80)), 5);
    expect(errorAt(state, ray, to.mid)).toBeLessThan(0.25);
  });

  it("still drags by the live sensitivity when no view is measured, and zooms from the centre", () => {
    let state = start;
    const model = createLookModel(start, () => settings, next => { state = next; });
    model.drag(100, 0, 16);
    expect(state.headingDeg).toBeCloseTo(start.headingDeg - 15, 6);
    expect(state.pitchDeg).toBeCloseTo(start.pitchDeg, 6);
    model.wheel(-100, { x: 10, y: 10 });
    expect(state.headingDeg).toBeCloseTo(start.headingDeg - 15, 6);
    expect(state.verticalFovDeg).toBeCloseTo(zoomFov(70, settings.zoomPerNotch), 6);
  });

  it("uses the same solver for a tab camera, including a measured view", () => {
    let camera: SphereCamera | null = start;
    const target = createSphereCameraTarget({
      get: () => camera,
      set: next => { camera = next; },
      viewport: () => viewport,
      settings: () => settings,
    });
    const at = { x: 180, y: 420 };
    const ray = sphereRay(start, viewport, at);
    target.wheel(-200, at);
    expect(camera).not.toBeNull();
    expect(errorAt(camera!, ray, at)).toBeLessThan(0.25);
    const pitched = camera!.pitchDeg;
    target.drag(0, 20, 16);
    expect(camera!.pitchDeg).toBeCloseTo(pitched + 3, 4);
  });
});
