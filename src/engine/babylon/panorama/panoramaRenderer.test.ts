import { BaseTexture, FreeCamera, NullEngine, Scene, ShaderLanguage, ShaderMaterial, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { length, type Mat3, type Vec3 } from "../../../scenes/panoramaMath";
import { createPanoramaRenderer, orbQuad } from "./panoramaRenderer";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

function setup(configure: (engine: NullEngine) => void = () => {}) {
  const engine = new NullEngine();
  configure(engine);
  engines.push(engine);
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new FreeCamera("camera", new Vector3(0, 0, -10), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  const requestRender = vi.fn();
  const onError = vi.fn();
  const renderer = createPanoramaRenderer(scene, { getPresentationView: () => null, requestRender, onError });
  return { camera, renderer, engine, scene, requestRender, onError };
}

describe("panorama renderer backends", () => {
  const content: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (const version of [1, 2]) it(`draws analytic orbs and immersion with GLSL on WebGL ${version}`, () => {
    const { renderer, scene } = setup(engine => {
      Object.assign(engine.getCaps(), { fragmentDepthSupported: true, standardDerivatives: true, textureLOD: false });
      Object.defineProperty(engine, "webGLVersion", { value: version });
    });
    expect(renderer.available).toBe(true);
    expect(renderer.unavailableReason).toBeNull();
    const texture = new BaseTexture(scene);
    renderer.addOrb("place", { marker: [0, 0, 0], radiusMeters: 1, content, texture, visible: true, outline: null, displayScale: 1 });
    const orbMaterial = scene.getMaterialByName("panorama-orb-material-place") as ShaderMaterial;
    expect(orbMaterial.options.shaderLanguage).toBe(ShaderLanguage.GLSL);
    expect(orbMaterial.options.defines.includes("#define PANORAMA_WEBGL2")).toBe(version === 2);
    expect(orbMaterial.options.defines.includes("#define PANORAMA_TEXTURE_GRADIENTS")).toBe(version === 2);
    renderer.immersion.show({ source: { texture, kind: "cube", content }, next: { texture, kind: "equirectangular", content }, mix: 0.5 });
    expect(renderer.immersion.visible).toBe(true);
    const immersion = scene.getMeshByName("panorama-immersion")!.material as ShaderMaterial;
    expect(immersion.options.shaderLanguage).toBe(ShaderLanguage.GLSL);
    expect(immersion.options.defines).toContain("#define NEXT_EQUIRECT");
    renderer.dispose();
  });

  it("enables seam-correct gradient sampling on WebGL 1 when its extension exists", () => {
    const { renderer, scene } = setup(engine => {
      Object.assign(engine.getCaps(), { fragmentDepthSupported: true, standardDerivatives: true, textureLOD: true });
      Object.defineProperty(engine, "webGLVersion", { value: 1 });
    });
    renderer.immersion.show({ source: { texture: new BaseTexture(scene), kind: "equirectangular", content } });
    const material = scene.getMeshByName("panorama-immersion")!.material as ShaderMaterial;
    expect(material.options.defines).toContain("#define PANORAMA_TEXTURE_GRADIENTS");
    expect(material.options.defines).not.toContain("#define PANORAMA_WEBGL2");
    renderer.dispose();
  });

  it("wakes a sleeping globe when a panorama shader finishes compiling", () => {
    const { renderer, scene, requestRender } = setup(engine => {
      Object.assign(engine.getCaps(), { fragmentDepthSupported: true, standardDerivatives: true });
    });
    renderer.immersion.show({ source: { texture: new BaseTexture(scene), kind: "equirectangular", content } });
    const material = scene.getMeshByName("panorama-immersion")!.material as ShaderMaterial;
    requestRender.mockClear();
    material.onCompiled?.(null as never);
    expect(requestRender).toHaveBeenCalledOnce();
    renderer.dispose();
    requestRender.mockClear();
    material.onCompiled?.(null as never);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("explains a missing WebGL 1 capability instead of silently drawing incorrect depth", () => {
    const { renderer } = setup(engine => {
      Object.assign(engine.getCaps(), { fragmentDepthSupported: false, standardDerivatives: true });
    });
    expect(renderer.available).toBe(false);
    expect(renderer.unavailableReason).toContain("EXT_frag_depth");
    renderer.dispose();
  });

  it("reports a shader rejection once and stops reporting after disposal", () => {
    const { renderer, scene, onError } = setup(engine => {
      Object.assign(engine.getCaps(), { fragmentDepthSupported: true, standardDerivatives: true });
    });
    renderer.immersion.show({ source: { texture: new BaseTexture(scene), kind: "equirectangular", content } });
    const material = scene.getMeshByName("panorama-immersion")!.material as ShaderMaterial;
    material.onError?.(null as never, "Driver rejected the shader");
    material.onError?.(null as never, "Driver rejected the shader");
    expect(onError).toHaveBeenCalledExactlyOnceWith("Driver rejected the shader");
    renderer.dispose();
    material.onError?.(null as never, "Another diagnostic after disposal");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("keeps WebGPU's WGSL path without requiring WebGL extensions", () => {
    const { renderer, scene } = setup(engine => {
      Object.defineProperties(engine, { isWebGPU: { value: true }, _device: { value: {} } });
    });
    expect(renderer.available).toBe(true);
    renderer.immersion.show({ source: { texture: new BaseTexture(scene), kind: "cube", content } });
    const material = scene.getMeshByName("panorama-immersion")!.material as ShaderMaterial;
    expect(material.options.shaderLanguage).toBe(ShaderLanguage.WGSL);
    expect(material.options.defines).not.toContain("#define PANORAMA_WEBGL2");
    renderer.dispose();
  });
});

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
