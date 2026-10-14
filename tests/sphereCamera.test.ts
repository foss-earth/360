import { describe, expect, it } from "vitest";
import { cross, dot, normalize } from "@foss-earth/images";
import { enuDirection } from "@foss-earth/engine/core";
import {
  anchorSphereCamera, projectSphereRay, sphereDirection, sphereRay, sphereViewBasis,
  type SphereCamera, type SpherePoseLimits, type SpherePoint, type SphereViewport,
} from "../src/sphereCamera.js";

const viewport: SphereViewport = { width: 800, height: 600 };
const limits: SpherePoseLimits = { fovDeg: { min: 20, max: 100 }, pitchDeg: { min: -85, max: 85 } };
const wide: SpherePoseLimits = { fovDeg: { min: 5, max: 140 }, pitchDeg: { min: -89.9, max: 89.9 } };

function camera(partial: Partial<SphereCamera> = {}): SphereCamera {
  return { headingDeg: 20, pitchDeg: -12, verticalFovDeg: 60, ...partial };
}

function errorAt(pose: SphereCamera, ray: readonly [number, number, number], point: SpherePoint): number {
  const projected = projectSphereRay(pose, viewport, ray);
  if (!projected) return Number.POSITIVE_INFINITY;
  return Math.hypot(projected.x - point.x, projected.y - point.y);
}

describe("sphere camera", () => {
  it("uses the common frame: X right, Y forward, Z up, with no roll", () => {
    const basis = sphereViewBasis({ headingDeg: 0, pitchDeg: 0, verticalFovDeg: 60 }, viewport);
    expect(basis.forward).toEqual([0, 1, 0]);
    expect(basis.right[0]).toBeCloseTo(1, 12);
    expect(basis.up[2]).toBeCloseTo(1, 12);
    expect(basis.aspect).toBeCloseTo(800 / 600, 12);
    for (const heading of [0, 37, 180, 359]) for (const pitch of [-80, -20, 0, 40, 85]) {
      const level = sphereViewBasis({ headingDeg: heading, pitchDeg: pitch, verticalFovDeg: 50 }, viewport);
      expect(Math.abs(level.right[2])).toBeLessThan(1e-12);
      expect(dot(level.right, level.forward)).toBeCloseTo(0, 10);
      expect(dot(normalize(cross(level.right, level.forward)), level.up)).toBeCloseTo(1, 10);
      expect(sphereDirection(heading, pitch)).toEqual(enuDirection(heading, pitch));
    }
  });

  it("projects a ray back onto the point it was cast through", () => {
    const pose = camera();
    for (const point of [{ x: 400, y: 300 }, { x: 12.5, y: 580 }, { x: 790, y: 8 }, { x: 250.25, y: 410.5 }]) {
      const ray = sphereRay(pose, viewport, point);
      const back = projectSphereRay(pose, viewport, ray);
      expect(back).not.toBeNull();
      expect(back!.x).toBeCloseTo(point.x, 6);
      expect(back!.y).toBeCloseTo(point.y, 6);
    }
    expect(projectSphereRay(pose, viewport, [0, -1, 0])).toBeNull();
  });

  it("keeps an off-centre ray on its point through zoom, including a clamped field of view", () => {
    let pose = camera();
    const anchor = { x: 137.25, y: 511.5 };
    const ray = sphereRay(pose, viewport, anchor);
    for (const fov of [45, 28, 10, 140, 80, 20, 100]) {
      pose = anchorSphereCamera(pose, viewport, ray, anchor, fov, limits);
      expect(pose.verticalFovDeg).toBeGreaterThanOrEqual(limits.fovDeg.min);
      expect(pose.verticalFovDeg).toBeLessThanOrEqual(limits.fovDeg.max);
      expect(errorAt(pose, ray, anchor)).toBeLessThan(0.25);
    }
    expect(pose.verticalFovDeg).toBe(limits.fovDeg.max);
  });

  it("follows the heading across a full turn instead of a distant branch", () => {
    const pose = camera({ headingDeg: 350, pitchDeg: 5, verticalFovDeg: 70 });
    const anchor = { x: 700, y: 280 };
    const ray = sphereRay(pose, viewport, anchor);
    const next = anchorSphereCamera(pose, viewport, ray, anchor, 30, wide);
    expect(errorAt(next, ray, anchor)).toBeLessThan(0.25);
    const turn = ((next.headingDeg - 350 + 540) % 360) - 180;
    expect(turn).toBeGreaterThan(0);
    expect(turn).toBeLessThan(40);
    expect(next.headingDeg).toBeLessThan(40);
  });

  it("stops at the last feasible pose near a pole, without roll, a pitch clamp, or the other branch", () => {
    const pose = camera({ headingDeg: 15, pitchDeg: 78, verticalFovDeg: 40 });
    const anchor = { x: 620, y: 470 };
    const ray = sphereRay(pose, viewport, anchor);
    const next = anchorSphereCamera(pose, viewport, ray, anchor, 130, { fovDeg: { min: 10, max: 140 }, pitchDeg: { min: -85, max: 85 } });
    expect(next.verticalFovDeg).toBeLessThan(130);
    expect(next.verticalFovDeg).toBeGreaterThan(pose.verticalFovDeg);
    expect(next.pitchDeg).toBeLessThanOrEqual(85);
    expect(next.pitchDeg).toBeGreaterThan(70);
    expect(errorAt(next, ray, anchor)).toBeLessThan(0.25);
    const basis = sphereViewBasis(next, viewport);
    expect(Math.abs(basis.right[2])).toBeLessThan(1e-12);
    const turn = ((next.headingDeg - pose.headingDeg + 540) % 360) - 180;
    expect(Math.abs(turn)).toBeLessThan(80);
    const stepped = anchorSphereCamera(next, viewport, ray, anchor, next.verticalFovDeg + 0.05, { fovDeg: { min: 10, max: 140 }, pitchDeg: { min: -85, max: 85 } });
    expect(stepped.verticalFovDeg).toBeCloseTo(next.verticalFovDeg, 4);
  });

  it("moves a pinch's ray from the old midpoint to the new one with the new field of view", () => {
    const pose = camera({ headingDeg: 200, pitchDeg: 8, verticalFovDeg: 55 });
    const from = { x: 280, y: 220 };
    const to = { x: 340, y: 275 };
    const ray = sphereRay(pose, viewport, from);
    const next = anchorSphereCamera(pose, viewport, ray, to, 40, wide, from);
    expect(next.verticalFovDeg).toBeCloseTo(40, 6);
    expect(errorAt(next, ray, to)).toBeLessThan(0.25);
    expect(Math.abs(((next.headingDeg - pose.headingDeg + 540) % 360) - 180)).toBeLessThan(50);
  });
});
