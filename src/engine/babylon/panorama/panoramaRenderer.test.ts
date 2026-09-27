import { FreeCamera, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { length, type Vec3 } from "../../../scenes/panoramaMath";
import { createPanoramaRenderer, orbQuad } from "./panoramaRenderer";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

function setup() {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new FreeCamera("camera", new Vector3(0, 0, -10), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  const renderer = createPanoramaRenderer(scene, { getPresentationView: () => null, requestRender: () => {} });
  return { camera, renderer };
}

describe("panorama renderer camera frame", () => {
  it("follows a camera moved after it was read in the same rendered frame", () => {
    const { camera, renderer } = setup();
    const before = renderer.cameraFrame()!;
    expect(before.eye.map(value => Math.round(value * 1e9) / 1e9)).toEqual([0, 0, -10]);
    // Nothing is rendered between the two reads: the engine frame is the same.
    camera.position = new Vector3(5, 0, -10);
    camera.setTarget(Vector3.Zero());
    const after = renderer.cameraFrame()!;
    expect(after.eye[0]).toBeCloseTo(5, 9);
    expect(after.revision).not.toBe(before.revision);
    expect(after.view.forward[0]).toBeLessThan(0);
  });

  it("reads the eye and the view from the same camera state", () => {
    const { camera, renderer } = setup();
    renderer.cameraFrame();
    camera.position = new Vector3(0, 3, -4);
    camera.setTarget(Vector3.Zero());
    const frame = renderer.cameraFrame()!;
    // The forward axis points from the eye to the target, within the view matrix's float32 precision.
    const distance = Math.hypot(...frame.eye);
    for (let axis = 0; axis < 3; axis++) expect(frame.eye[axis] + frame.view.forward[axis] * distance).toBeCloseTo(0, 6);
  });
});

describe("orb geometry", () => {
  it("leaves room beyond the silhouette for an outline, in CSS px at the orb's distance", () => {
    const frame = { view: { forward: [0, 0, 1] as Vec3, right: [1, 0, 0] as Vec3, up: [0, 1, 0] as Vec3, verticalFovRad: Math.PI / 2, aspect: 1 }, viewportHeightCssPx: 1000 };
    const plain = orbQuad([0, 0, 100], 1, frame, 0.1);
    const outlined = orbQuad([0, 0, 100], 1, frame, 0.1, 4);
    // 100 m away, 1000 CSS px span 200 m.
    expect(length(outlined.u) - length(plain.u)).toBeCloseTo(4 * 0.2, 9);
    expect(length(outlined.v) - length(plain.v)).toBeCloseTo(4 * 0.2, 9);
  });
});
