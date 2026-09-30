import { BaseTexture, FreeCamera, Matrix, NullEngine, Scene, ShaderLanguage, ShaderMaterial, Vector3, Vector4 } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dot, length, normalize, type Mat3, type Vec3 } from "../../../scenes/panoramaMath";
import { createPanoramaRenderer, imageFromClipMatrix, orbDrawConstants, orbQuad, type PanoramaRendererExperiments } from "./panoramaRenderer";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

function setup(configure: (engine: NullEngine) => void = () => {}, experiments: Partial<PanoramaRendererExperiments> = {}) {
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
  const renderer = createPanoramaRenderer(scene, { getPresentationView: () => null, requestRender, onError, experiments });
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

describe("panorama renderer experiments", () => {
  const content: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  // WebGL 1: the null engine has no uniform buffers to render a WebGL 2 frame with.
  const webGl = (engine: NullEngine) => {
    Object.assign(engine.getCaps(), { fragmentDepthSupported: true, standardDerivatives: true });
    Object.defineProperty(engine, "webGLVersion", { value: 1 });
  };
  const orbState = (scene: Scene) => ({ marker: [0, 0, 0] as Vec3, radiusMeters: 1, content, texture: new BaseTexture(scene), visible: true, outline: null, displayScale: 1 });

  it("records draws only while a check captures once the bookkeeping experiment is on", () => {
    const { renderer, scene } = setup(webGl);
    renderer.addOrb("place", orbState(scene));
    scene.render();
    expect(renderer.drawRecords().length).toBeGreaterThan(0);

    renderer.setExperiments({ bookkeeping: true });
    const kept = renderer.drawRecords().length;
    scene.render();
    expect(renderer.drawRecords()).toHaveLength(kept);

    renderer.captureDraws(true);
    scene.render();
    const records = renderer.drawRecords();
    expect(records.length).toBeGreaterThan(kept);
    // The revision a check reads is the same text either way, formatted when read.
    expect(records[0].cameraRevision).toBe(records[0].uniformRevision);
    expect(records[0].cameraRevision.split(",")).toHaveLength(11);
    renderer.dispose();
  });

  it("gives the same camera revision with the bookkeeping experiment as without", () => {
    const plain = setup(webGl).renderer.cameraFrame()!;
    const lean = setup(webGl, { bookkeeping: true }).renderer.cameraFrame()!;
    expect(lean.revision).toBe(plain.revision);
    expect({ ...lean }.revision).toBe(plain.revision);
  });

  it("keeps a check's negative control working with the bookkeeping experiment", () => {
    const { renderer, scene, camera, engine } = setup(webGl, { bookkeeping: true });
    renderer.addOrb("place", orbState(scene));
    renderer.captureDraws(true);
    renderer.setUniformDelayFrames(1);
    for (let frame = 0; frame < 3; frame++) {
      camera.position = new Vector3(frame, 0, -10);
      // A frame of its own: the engine's frame id is what the history keys on.
      engine.beginFrame();
      scene.render();
      engine.endFrame();
    }
    const last = renderer.drawRecords().at(-1)!;
    expect(last.uniformRevision).not.toBe(last.cameraRevision);
    renderer.dispose();
  });

  it("draws immersion at full opacity without blending, and a fade with it", () => {
    const { renderer, scene } = setup(webGl, { opaqueImmersion: true });
    const texture = new BaseTexture(scene);
    const material = () => scene.getMeshByName("panorama-immersion")!.material as ShaderMaterial;
    renderer.immersion.show({ source: { texture, kind: "cube", content }, next: { texture, kind: "equirectangular", content }, mix: 0.5 });
    expect(material().needAlphaBlending()).toBe(false);
    renderer.immersion.show({ source: { texture, kind: "cube", content }, opacity: 0.5 });
    expect(material().needAlphaBlending()).toBe(true);
    renderer.immersion.show({ source: { texture, kind: "cube", content } });
    expect(material().needAlphaBlending()).toBe(false);
    renderer.setExperiments({ opaqueImmersion: false });
    expect(material().needAlphaBlending()).toBe(true);
    renderer.dispose();
  });

  it("switches every orb and the immersion to the lean WebGL shaders, and leaves WebGPU's alone", () => {
    const { renderer, scene } = setup(webGl);
    renderer.addOrb("place", orbState(scene));
    const orb = scene.getMaterialByName("panorama-orb-material-place") as ShaderMaterial;
    renderer.immersion.show({ source: { texture: new BaseTexture(scene), kind: "cube", content } });
    const immersion = () => scene.getMeshByName("panorama-immersion")!.material as ShaderMaterial;
    expect(orb.options.defines).not.toContain("#define PANORAMA_LEAN");
    expect(immersion().options.defines).not.toContain("#define PANORAMA_LEAN");
    renderer.setExperiments({ shaders: true });
    expect(orb.options.defines).toContain("#define PANORAMA_LEAN");
    expect(immersion().options.defines).toContain("#define PANORAMA_LEAN");
    renderer.setExperiments({ shaders: false });
    expect(orb.options.defines).not.toContain("#define PANORAMA_LEAN");
    renderer.dispose();

    const gpu = setup(engine => Object.defineProperties(engine, { isWebGPU: { value: true }, _device: { value: {} } }), { shaders: true });
    gpu.renderer.addOrb("place", orbState(gpu.scene));
    expect((gpu.scene.getMaterialByName("panorama-orb-material-place") as ShaderMaterial).options.defines).not.toContain("#define PANORAMA_LEAN");
    gpu.renderer.dispose();
  });
});

describe("lean shader inputs", () => {
  it("turn a clip-space corner into the ray the full shader rotates into the image", () => {
    const angle = 0.7;
    const content: Mat3 = [[Math.cos(angle), 0, -Math.sin(angle)], [0.3 * Math.sin(angle), Math.cos(0.3), 0.3], [Math.sin(angle), 0, Math.cos(angle)]].map(row => normalize(row as Vec3)) as Mat3;
    const rotation = Matrix.RotationYawPitchRoll(0.4, -0.2, 0.1);
    for (const projection of [Matrix.PerspectiveFovRH(1, 1.6, 0.1, 1000, false), Matrix.PerspectiveFovRH(0.6, 0.5, 2, 1e7, true)]) {
      const inverse = rotation.multiply(projection).invert();
      const lean = imageFromClipMatrix(inverse, content, new Matrix());
      for (const [x, y] of [[-1, -1], [3, -1], [-1, 3], [0.25, -0.5]]) {
        const ray = Vector4.TransformCoordinates(new Vector3(x, y, 0.5), inverse);
        const world = normalize([ray.x / ray.w, ray.y / ray.w, ray.z / ray.w]);
        const expected = normalize(content.map(row => dot(row, world)) as Vec3);
        const image = Vector4.TransformCoordinates(new Vector3(x, y, 0.5), lean);
        const actual = normalize([image.x, image.y, image.z]);
        for (let axis = 0; axis < 3; axis++) expect(actual[axis]).toBeCloseTo(expected[axis], 5);
        // w is the same at every corner, so the lean ray needs no division.
        expect(image.w).toBeCloseTo(1, 5);
      }
    }
  });

  it("gives an orb's per-draw constants as its fragments work them out", () => {
    for (const [rel, radius] of [[[0, 3, 40], 2], [[1, 0, 0.5], 2], [[500, 20, 0], 0.5]] as [Vec3, number][]) {
      const tanPreview = Math.tan(Math.PI / 4);
      const constants = orbDrawConstants(rel, radius, tanPreview);
      const d = length(rel);
      const sinAlpha = Math.min(radius / d, 1);
      const tanAlpha = sinAlpha / Math.max(Math.sqrt(Math.max(1 - sinAlpha ** 2, 0)), 1e-7);
      expect(constants.sinAlpha).toBeCloseTo(sinAlpha, 12);
      expect(constants.windowGain).toBeCloseTo(tanPreview / Math.max(tanAlpha, 1e-7), 9);
      expect(constants.identityWindow).toBe(d <= radius || tanAlpha >= tanPreview);
    }
  });
});
