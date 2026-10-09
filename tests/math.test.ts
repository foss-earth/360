import { describe, expect, it } from "vitest";
import { angleDeg, length, normalize, sub, type Vec3 } from "@foss-earth/images";
import { enuDirection } from "@foss-earth/engine/core";
import { blendedWindowTheta, expansionTargetRadius, flatWindowDirection, flatWindowTheta, handoffReady, orbGeometry, projectedDiameterPx, radiusForDiameterPx, viewportCovered, viewRay, type ViewBasis } from "../src/index.js";
const DEG_TO_RAD = Math.PI / 180;
const BETA_R = 45 * DEG_TO_RAD;

function lookingAt(from: Vec3, target: Vec3, verticalFovDeg: number, aspect: number): ViewBasis {
  const forward = normalize(sub(target, from));
  const right = normalize([forward[1], -forward[0], 0]);
  const up = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]] as Vec3;
  return { forward, right, up, verticalFovRad: verticalFovDeg * DEG_TO_RAD, aspect };
}

describe("the flat window", () => {
  it("reproduces the required counterexample: covered, but a 30° ray samples 32.842°", () => {
    // Square 60° viewport, 90° preview, d/R = 1.5.
    const camera: Vec3 = [0, -1.5, 0];
    const view = lookingAt(camera, [0, 0, 0], 60, 1);
    const geometry = orbGeometry(sub([0, 0, 0], camera), 1);
    expect(geometry.alpha / DEG_TO_RAD).toBeCloseTo(41.810315, 5);
    expect(viewportCovered(geometry, view)).toBe(true);
    expect(handoffReady(geometry, view, BETA_R)).toBe(false);
    const ray = enuDirection(30, 0);
    const mapped = flatWindowDirection(geometry, ray, BETA_R)!;
    expect(angleDeg(mapped, [0, 1, 0])).toBeCloseTo(32.842130, 5);
  });

  it("agrees with the reference's angular form everywhere on the disc", () => {
    for (const distance of [8, 3, 1.58, 1.5, 1.42]) {
      const geometry = orbGeometry([0, distance, 0], 1);
      for (let i = 0; i <= 64; i++) {
        const delta = geometry.alpha * i / 64;
        const ray = enuDirection(delta / DEG_TO_RAD, 0);
        const mapped = flatWindowDirection(geometry, ray, BETA_R)!;
        const expected = flatWindowTheta(delta, geometry.alpha, BETA_R);
        expect(angleDeg(mapped, [0, 1, 0])).toBeCloseTo(expected / DEG_TO_RAD, 9);
      }
    }
  });

  it("is identity once α ≥ βR, and at and inside the surface", () => {
    const view = lookingAt([0, -1.3, 0], [0.2, 0, 0.1], 60, 16 / 9);
    for (const distance of [1 / Math.sin(BETA_R), 1.3, 1.000001, 1, 0.5, 0]) {
      const geometry = orbGeometry([0, distance, 0], 1);
      for (const [x, y] of [[0.5, 0.5], [0.2, 0.7], [0.9, 0.1]]) {
        const ray = viewRay(view, x, y);
        const mapped = flatWindowDirection(geometry, ray, BETA_R);
        if (mapped) expect(angleDeg(mapped, ray)).toBeLessThan(1e-9);
      }
    }
    // The outward ray at the surface is uncovered; just inside it is covered.
    expect(flatWindowDirection(orbGeometry([0, 1, 0], 1), [0, -1, 0], BETA_R)).toBeNull();
    expect(flatWindowDirection(orbGeometry([0, 0.999999, 0], 1), [0, -1, 0], BETA_R)).not.toBeNull();
  });

  it("stays finite and continuous across α = βR", () => {
    const threshold = 1 / Math.sin(BETA_R);
    for (const epsilon of [1e-3, 1e-6]) {
      const near = orbGeometry([0, threshold + epsilon, 0], 1);
      const far = orbGeometry([0, threshold - epsilon, 0], 1);
      for (const deg of [0, 10, 20, 30, 40]) {
        const ray = enuDirection(deg, 5);
        const a = flatWindowDirection(near, ray, BETA_R);
        const b = flatWindowDirection(far, ray, BETA_R);
        if (!a || !b) continue;
        expect(a.every(Number.isFinite)).toBe(true);
        expect(angleDeg(a, b)).toBeLessThan(epsilon * 100);
      }
    }
  });

  it("rejects half angles outside (0, 90)", () => {
    const geometry = orbGeometry([0, 3, 0], 1);
    for (const bad of [0, Math.PI / 2, Math.PI]) expect(() => flatWindowDirection(geometry, [0, 1, 0], bad)).toThrow(RangeError);
  });

  it("blends monotonically and finitely from fisheye to flat", () => {
    const options = { previewHalfAngleRad: BETA_R, fisheyeHalfAngleRad: Math.PI / 2, blendStartRad: 20 * DEG_TO_RAD, blendEndRad: BETA_R };
    for (const alphaDeg of [1e-6, 10, 20, 30, 44.999999, 45, 60, 89.999999]) {
      let previous = -1;
      for (let i = 0; i <= 256; i++) {
        const delta = alphaDeg * DEG_TO_RAD * i / 256;
        const theta = blendedWindowTheta(delta, alphaDeg * DEG_TO_RAD, options);
        expect(Number.isFinite(theta)).toBe(true);
        expect(theta).toBeGreaterThanOrEqual(previous);
        previous = theta;
      }
    }
    expect(() => blendedWindowTheta(0.1, 0.2, { ...options, blendStartRad: 46 * DEG_TO_RAD })).toThrow(RangeError);
  });
});

describe("expansion to a handoff", () => {
  it("reaches coverage and ray equality at the target radius, and never beyond 90°", () => {
    const camera: Vec3 = [0, 0, 0];
    const marker: Vec3 = [3, 40, 2];
    const view = lookingAt(camera, [0, 1, 0], 60, 16 / 9);
    const axis = normalize(marker);
    const radius = expansionTargetRadius(length(marker), axis, view, BETA_R)!;
    expect(radius).toBeLessThan(length(marker));
    const geometry = orbGeometry(marker, radius);
    expect(handoffReady(geometry, view, BETA_R)).toBe(true);
    const smaller = orbGeometry(marker, radius * 0.99);
    expect(handoffReady(smaller, view, BETA_R)).toBe(false);
    // An orb behind the viewer's shoulder cannot cover the view by growing.
    expect(expansionTargetRadius(40, normalize([40, -5, 0]), view, BETA_R)).toBeNull();
  });
});

describe("projected diameter", () => {
  it("inverts effective radius for every camera distance", () => {
    const fov = 60 * DEG_TO_RAD;
    const diameter = projectedDiameterPx(2, 100, fov, 900);
    expect(radiusForDiameterPx(diameter, 100, fov, 900)).toBeCloseTo(2, 12);
  });
});
