import { describe, expect, it } from "vitest";
import {
  createSphereSlot,
  initialSphereCamera,
  initialSphereSurfaceState,
  presentSphereSurface,
  resizeSphereSurface,
  setSphereWipe,
  withSphereCamera,
} from "../src/sphereSession.js";

const left = { tabId: "a", documentId: "doc-a", revision: "1", title: "A" };
const right = { tabId: "b", documentId: "doc-b", revision: "1", title: "B" };
const limits = { fovDeg: { min: 20, max: 90 }, pitchDeg: { min: -40, max: 40 } };

describe("sphere surface session", () => {
  it("starts the first source level and forward, and keeps that camera across swaps and an empty surface", () => {
    const empty = initialSphereSurfaceState({ width: 800, height: 600 });
    expect(empty.camera).toBeNull();
    const single = presentSphereSurface(empty, { kind: "single", side: "left", document: left }, limits);
    expect(single.camera).toEqual(initialSphereCamera(limits));
    expect(single.camera).toEqual({ headingDeg: 0, pitchDeg: 0, verticalFovDeg: 60 });
    const moved = withSphereCamera(single, { headingDeg: 140, pitchDeg: 12, verticalFovDeg: 40 });
    const pair = presentSphereSurface(moved, { kind: "pair", left, right });
    const swapped = presentSphereSurface(pair, { kind: "pair", left: right, right: left });
    const cleared = presentSphereSurface(swapped, { kind: "none" });
    const back = presentSphereSurface(cleared, { kind: "single", side: "right", document: right });
    expect(back.camera).toEqual(moved.camera);
    expect(resizeSphereSurface(back, { width: 400, height: 300 }).camera).toEqual(moved.camera);
  });

  it("changes the wipe without moving the camera", () => {
    const state = withSphereCamera(presentSphereSurface(initialSphereSurfaceState(), { kind: "pair", left, right }), { headingDeg: 10, pitchDeg: 0, verticalFovDeg: 50 });
    const wiped = setSphereWipe(state, 0.2);
    expect(wiped.wipe).toBe(0.2);
    expect(wiped.camera).toBe(state.camera);
    expect(setSphereWipe(wiped, 4).wipe).toBe(1);
    expect(setSphereWipe(wiped, Number.NaN)).toBe(wiped);
  });

  it("clamps the first camera to the supplied limits", () => {
    expect(initialSphereCamera({ fovDeg: { min: 70, max: 80 }, pitchDeg: { min: 5, max: 10 } })).toEqual({ headingDeg: 0, pitchDeg: 5, verticalFovDeg: 70 });
  });
});

describe("sphere slot", () => {
  it("publishes a whole source once, keeps it through a revision, and refuses a stale or cleared token", () => {
    const slot = createSphereSlot<{ id: string; table: number[] }>();
    expect(slot.publish(0, { id: "first", table: [1] })).toBe(true);
    const token = slot.revise();
    expect(slot.published?.id).toBe("first");
    expect(slot.publish(0, { id: "stale", table: [] })).toBe(false);
    expect(slot.published?.id).toBe("first");
    const next = { id: "second", table: [-1, -1] };
    expect(slot.publish(token, next)).toBe(true);
    expect(slot.published).toBe(next);
    next.table[0] = 3;
    expect(slot.published?.table).toEqual([3, -1]);
    const cancelled = slot.revise();
    slot.clear();
    expect(slot.published).toBeNull();
    expect(slot.publish(cancelled, { id: "late", table: [] })).toBe(false);
    expect(slot.published).toBeNull();
  });
});
