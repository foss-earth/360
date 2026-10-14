import { BaseTexture, Constants, FreeCamera, NullEngine, Scene, ShaderMaterial, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fitRectangleCamera, rectanglePlanePointAt, nativeRectangleCamera, zoomRectangleCamera } from "../src/rectangleCamera.js";
import { createRectangleSurfaceRenderer, rectangleSurfacePass, type RectangleSurfaceDraw } from "../src/rectangleRenderer.js";

const extent = { width: 1920, height: 1080 };

function draw(overrides: Partial<RectangleSurfaceDraw> = {}): RectangleSurfaceDraw {
  const framebufferRect = overrides.framebufferRect ?? { x: 100, y: 40, width: 1500, height: 900 };
  const pixelsPerCss = overrides.pixelsPerCss ?? { x: 1.5, y: 1.5 };
  return {
    framebufferRect, pixelsPerCss, extent,
    camera: fitRectangleCamera(extent, { width: framebufferRect.width / pixelsPerCss.x, height: framebufferRect.height / pixelsPerCss.y }),
    left: { source: null }, right: { source: null }, wipe: 0.25, sampling: "linear", background: [0.5, 0.5, 0.5],
    ...overrides,
  };
}

/** The plane point the shader interpolates at a framebuffer pixel's centre, i and j from the surface's top-left pixel. */
function shaderPlanePoint(planeRect: readonly number[], rect: { width: number; height: number }, i: number, j: number) {
  const u = (i + 0.5) / rect.width, v = (j + 0.5) / rect.height;
  return { x: planeRect[0] + u * planeRect[2], y: planeRect[1] + v * planeRect[3] };
}

describe("rectangle surface pass", () => {
  it("puts the camera's plane point at every framebuffer pixel centre", () => {
    const base = draw();
    const camera = zoomRectangleCamera(base.camera, { x: 321.7, y: 123.4 }, base.camera.scale * 7.3, { min: 1e-3, max: 1e3 });
    const surface = { ...base, camera };
    const pass = rectangleSurfacePass(surface, 2000, 1200)!;
    for (const [i, j] of [[0, 0], [1, 0], [749, 450], [1499, 899]]) {
      const expected = rectanglePlanePointAt(camera, { x: (i + 0.5) / 1.5, y: (j + 0.5) / 1.5 });
      const actual = shaderPlanePoint(pass.planeRect, surface.framebufferRect, i, j);
      expect(actual.x).toBeCloseTo(expected.x, 9);
      expect(actual.y).toBeCloseTo(expected.y, 9);
    }
  });

  it("gives Babylon a bottom-left viewport of whole pixels", () => {
    expect(rectangleSurfacePass(draw(), 2000, 1200)!.viewport).toEqual({ x: 100, y: 1200 - 40 - 900, width: 1500, height: 900 });
  });

  it("lands texel centres on pixel centres under native inspection", () => {
    const base = draw({ pixelsPerCss: { x: 2, y: 2 } });
    const result = nativeRectangleCamera(base.camera, extent, extent, { x: 2, y: 2 }, { width: 750, height: 450 });
    if (!result.ok) throw new Error(result.reason);
    const pass = rectangleSurfacePass({ ...base, camera: result.camera }, 2000, 1200)!;
    for (const i of [0, 1, 2, 700, 1499]) {
      const plane = shaderPlanePoint(pass.planeRect, base.framebufferRect, i, 0).x;
      expect(Math.abs(plane - Math.floor(plane) - 0.5)).toBeLessThan(1e-6);
    }
  });

  it("pins the wipe to the one side that takes part, and clamps it for a pair", () => {
    expect(rectangleSurfacePass(draw({ right: null }), 2000, 1200)!.wipe).toBe(1);
    expect(rectangleSurfacePass(draw({ left: null }), 2000, 1200)!.wipe).toBe(0);
    expect(rectangleSurfacePass(draw({ wipe: 7 }), 2000, 1200)!.wipe).toBe(1);
    expect(rectangleSurfacePass(draw(), 2000, 1200)!.wipe).toBe(0.25);
  });

  it("draws nothing for an empty rectangle or one outside the framebuffer", () => {
    expect(rectangleSurfacePass(draw({ framebufferRect: { x: 0, y: 0, width: 0, height: 10 } }), 2000, 1200)).toBeNull();
    expect(rectangleSurfacePass(draw(), 1000, 1200)).toBeNull();
  });

  it("converts the background to linear light", () => {
    const pass = rectangleSurfacePass(draw({ background: [0, 1, 0.5] }), 2000, 1200)!;
    expect(pass.backgroundLinear[0]).toBe(0);
    expect(pass.backgroundLinear[1]).toBe(1);
    expect(pass.backgroundLinear[2]).toBeCloseTo(0.214, 3);
  });
});

describe("rectangle surface renderer", () => {
  const engines: NullEngine[] = [];
  afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); vi.restoreAllMocks(); });

  function setup() {
    const engine = new NullEngine({ renderWidth: 2000, renderHeight: 1200, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 1 });
    engines.push(engine);
    const scene = new Scene(engine);
    new FreeCamera("camera", new Vector3(0, 0, -10), scene);
    return { engine, scene };
  }

  it("draws each surface in its own viewport after the world, and restores the state it changed", () => {
    const { engine, scene } = setup();
    const requestRender = vi.fn();
    const renderer = createRectangleSurfaceRenderer(scene, { requestRender });
    expect(renderer.available).toBe(true);
    vi.spyOn(ShaderMaterial.prototype, "isReady").mockReturnValue(true);
    const viewports: unknown[] = [];
    const setViewport = engine.setViewport.bind(engine);
    vi.spyOn(engine, "setViewport").mockImplementation((viewport, width, height) => { viewports.push({ ...viewport, width: viewport.width, height: viewport.height, required: width ?? null }); setViewport(viewport, width, height); });
    const texture = new BaseTexture(scene);
    const left = { source: { texture, width: 960, height: 540 } };
    const surface = renderer.addSurface(() => draw({ left, right: { source: null } }));
    expect(requestRender).toHaveBeenCalled();
    // The state just before the pass, set to what it must not leave changed, and the state just after.
    const state = () => ({ depth: engine.getDepthBuffer(), depthWrite: engine.getDepthWrite(), alpha: engine.getAlphaMode(), viewport: engine.currentViewport });
    let before: ReturnType<typeof state> | null = null, after: ReturnType<typeof state> | null = null;
    scene.onAfterRenderObservable.add(() => {
      // An alpha mode turns depth writing off, so it is set first.
      engine.setAlphaMode(Constants.ALPHA_COMBINE);
      engine.setDepthBuffer(true);
      engine.setDepthWrite(true);
      before = state();
    }, undefined, true);
    scene.onAfterRenderObservable.add(() => { after = state(); });
    scene.render();
    const drawn = viewports.find(entry => (entry as { required: number | null }).required === 1);
    expect(drawn).toMatchObject({ x: 100, y: 260, width: 1500, height: 900 });
    expect(before).toMatchObject({ depth: true, depthWrite: true, alpha: Constants.ALPHA_COMBINE });
    expect(after).toEqual(before);
    surface.dispose();
    renderer.dispose();
  });

  it("chooses a material by which sides have a source", () => {
    const { scene } = setup();
    const renderer = createRectangleSurfaceRenderer(scene, { requestRender() {} });
    const created = vi.spyOn(ShaderMaterial.prototype, "isReady").mockReturnValue(false);
    renderer.addSurface(() => draw({ left: { source: null }, right: { source: null } }));
    scene.render();
    expect(created).toHaveBeenCalled();
    expect(scene.materials.map(material => material.name)).toContain("rectangle-image-surface-empty");
    renderer.dispose();
    expect(scene.materials.some(material => material.name.startsWith("rectangle-image-surface"))).toBe(false);
    expect(scene.meshes.some(mesh => mesh.name === "rectangle-image-surface")).toBe(false);
  });

  it("binds a ready replacement before checking a cached material with an unready old source", () => {
    const { scene } = setup();
    const renderer = createRectangleSurfaceRenderer(scene, { requestRender() {} });
    const oldTexture = new BaseTexture(scene), replacement = new BaseTexture(scene);
    let current = oldTexture;
    renderer.addSurface(() => draw({ left: { source: { texture: current, width: 960, height: 540 } }, right: null }));
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
