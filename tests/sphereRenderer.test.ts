import { BaseTexture, Constants, FreeCamera, NullEngine, Scene, ShaderMaterial, Vector3 } from "@babylonjs/core";
import { normalize } from "@foss-earth/images";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sphereRay, sphereViewBasis, type SphereCamera } from "../src/sphereCamera.js";
import { createSphereSurfaceRenderer, sphereSurfacePass, sphereSurfaceVariant, type SphereSurfaceDraw, type SphereSurfaceSource } from "../src/sphereRenderer.js";

const viewport = { width: 800, height: 600 };
const camera: SphereCamera = { headingDeg: 25, pitchDeg: -18, verticalFovDeg: 64 };
const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const;

function source(kind: SphereSurfaceSource["kind"], texture: BaseTexture): SphereSurfaceSource {
  return { texture, kind, width: 64, height: 32, contentFromCommon: identity };
}

function draw(overrides: Partial<SphereSurfaceDraw> = {}): SphereSurfaceDraw {
  return {
    framebufferRect: { x: 40, y: 20, width: 800, height: 600 },
    basis: sphereViewBasis(camera, viewport),
    left: { source: null }, right: { source: null }, wipe: 0.3, sampling: "linear", background: [0.2, 0.2, 0.2],
    ...overrides,
  };
}

function shaderRay(pass: NonNullable<ReturnType<typeof sphereSurfacePass>>, i: number, j: number, width: number, height: number) {
  const x = (i + 0.5) / width, y = (j + 0.5) / height;
  const sx = (x * 2 - 1) * pass.tanHalf * pass.aspect, sy = (1 - y * 2) * pass.tanHalf;
  return normalize([
    pass.forward[0] + pass.right[0] * sx + pass.up[0] * sy,
    pass.forward[1] + pass.right[1] * sx + pass.up[1] * sy,
    pass.forward[2] + pass.right[2] * sx + pass.up[2] * sy,
  ]);
}

describe("sphere surface pass", () => {
  it("casts the camera's ray through every framebuffer pixel centre", () => {
    const pass = sphereSurfacePass(draw(), 2000, 1200)!;
    for (const [i, j] of [[0, 0], [1, 2], [399, 250], [799, 599]]) {
      const expected = sphereRay(camera, viewport, { x: i + 0.5, y: j + 0.5 });
      const actual = shaderRay(pass, i, j, 800, 600);
      expect(actual[0]).toBeCloseTo(expected[0], 9);
      expect(actual[1]).toBeCloseTo(expected[1], 9);
      expect(actual[2]).toBeCloseTo(expected[2], 9);
    }
  });

  it("gives Babylon a bottom-left viewport and pins a single side's wipe", () => {
    expect(sphereSurfacePass(draw(), 2000, 1200)!.viewport).toEqual({ x: 40, y: 1200 - 20 - 600, width: 800, height: 600 });
    expect(sphereSurfacePass(draw({ right: null }), 2000, 1200)!.wipe).toBe(1);
    expect(sphereSurfacePass(draw({ left: null }), 2000, 1200)!.wipe).toBe(0);
    expect(sphereSurfacePass(draw({ wipe: 9 }), 2000, 1200)!.wipe).toBe(1);
  });

  it("draws nothing for an empty rectangle, one outside the framebuffer, or a basis that cannot cast a ray", () => {
    expect(sphereSurfacePass(draw({ framebufferRect: { x: 0, y: 0, width: 0, height: 10 } }), 2000, 1200)).toBeNull();
    expect(sphereSurfacePass(draw(), 100, 100)).toBeNull();
    const basis = sphereViewBasis(camera, viewport);
    expect(sphereSurfacePass(draw({ basis: { ...basis, verticalFovRad: 0 } }), 2000, 1200)).toBeNull();
  });
});

describe("sphere surface variants", () => {
  it("names only the samplers a steady tiled pair uses", () => {
    const pair = sphereSurfaceVariant("tiles", "tiles");
    expect(pair.samplers).toEqual(["leftCube", "leftTileAtlas", "leftTileTable", "rightCube", "rightTileAtlas", "rightTileTable"]);
    expect(pair.defines).toEqual(["#define LEFT_CUBE", "#define LEFT_TILES", "#define RIGHT_CUBE", "#define RIGHT_TILES"]);
    expect(sphereSurfaceVariant("equirectangular", "cube").samplers).toEqual(["leftEquirect", "rightCube"]);
    expect(sphereSurfaceVariant(null, null).samplers).toEqual([]);
  });
});

describe("sphere surface renderer", () => {
  const engines: NullEngine[] = [];
  afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); vi.restoreAllMocks(); });

  function setup() {
    const engine = new NullEngine({ renderWidth: 2000, renderHeight: 1200, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 1 });
    engines.push(engine);
    const scene = new Scene(engine);
    new FreeCamera("camera", new Vector3(0, 0, -10), scene);
    return { engine, scene };
  }

  it("draws a surface in its viewport after the world and restores the state it changed", () => {
    const { engine, scene } = setup();
    const errors: string[] = [];
    const renderer = createSphereSurfaceRenderer(scene, { requestRender() {}, onError: message => errors.push(message) });
    expect(renderer.available).toBe(true);
    vi.spyOn(ShaderMaterial.prototype, "isReady").mockReturnValue(true);
    const viewports: unknown[] = [];
    const setViewport = engine.setViewport.bind(engine);
    vi.spyOn(engine, "setViewport").mockImplementation((viewport, width, height) => {
      viewports.push({ ...viewport, required: width ?? null });
      setViewport(viewport, width, height);
    });
    renderer.addSurface(() => draw());
    const state = () => ({ depth: engine.getDepthBuffer(), depthWrite: engine.getDepthWrite(), alpha: engine.getAlphaMode(), viewport: engine.currentViewport });
    let before: ReturnType<typeof state> | null = null, after: ReturnType<typeof state> | null = null;
    scene.onAfterRenderObservable.add(() => {
      engine.setAlphaMode(Constants.ALPHA_COMBINE);
      engine.setDepthBuffer(true);
      engine.setDepthWrite(true);
      before = state();
    }, undefined, true);
    scene.onAfterRenderObservable.add(() => { after = state(); });
    scene.render();
    expect(errors).toEqual([]);
    expect(viewports.find(entry => (entry as { required: number | null }).required === 1)).toMatchObject({ x: 40, y: 580, width: 800, height: 600 });
    expect(before).toMatchObject({ depth: true, depthWrite: true, alpha: Constants.ALPHA_COMBINE });
    expect(after).toEqual(before);
    renderer.dispose();
  });

  it("makes one material per source pair and binds only that pair's textures", () => {
    const { scene } = setup();
    const renderer = createSphereSurfaceRenderer(scene, { requestRender() {} });
    const cube = new BaseTexture(scene), atlas = new BaseTexture(scene), table = new BaseTexture(scene);
    const tiles = { atlas, table, layout: [1, 8, 0, 8] as const, atlasSize: [8, 8] as const, warp: "gnomonic" as const, outlines: false };
    renderer.addSurface(() => draw({
      left: { source: { ...source("tiles", cube), tiles } },
      right: { source: source("equirectangular", new BaseTexture(scene)) },
    }));
    vi.spyOn(ShaderMaterial.prototype, "isReady").mockReturnValue(false);
    scene.render();
    const material = scene.materials.find(item => item.name.startsWith("sphere-image-surface"));
    expect(material?.name).toContain("LEFT_CUBE");
    expect(material?.name).toContain("LEFT_TILES");
    expect(material?.name).toContain("RIGHT_EQUIRECT");
    renderer.dispose();
    expect(scene.meshes.some(mesh => mesh.name === "sphere-image-surface")).toBe(false);
  });

  it("binds a ready replacement before checking a cached material with an unready old source", () => {
    const { scene } = setup();
    const renderer = createSphereSurfaceRenderer(scene, { requestRender() {} });
    const oldTexture = new BaseTexture(scene), replacement = new BaseTexture(scene);
    let current = oldTexture;
    renderer.addSurface(() => draw({ left: { source: source("cube", current) }, right: null }));
    vi.spyOn(oldTexture, "isReady").mockReturnValue(false);
    vi.spyOn(replacement, "isReady").mockReturnValue(true);
    const checked: BaseTexture[][] = [];
    vi.spyOn(ShaderMaterial.prototype, "isReady").mockImplementation(function (this: ShaderMaterial) {
      const textures = this.getActiveTextures();
      checked.push(textures);
      return textures.every(texture => texture.isReady());
    });
    scene.render();
    expect(checked.some(textures => textures.includes(oldTexture))).toBe(true);
    checked.length = 0;
    current = replacement;
    scene.render();
    expect(checked.length).toBeGreaterThan(0);
    expect(checked.every(textures => textures.includes(replacement) && !textures.includes(oldTexture))).toBe(true);
    renderer.dispose();
  });
});
