/**
 * Draws rectangle image surfaces into their own measured rectangles of the shared
 * canvas (docs/proposals/shared-image-viewer-implementation.md §6). Each
 * surface is one quad in the globe scene's frame, drawn after the scene and
 * its post-processes, with no world depth, lighting or tone mapping. A pass
 * sets its viewport, scissor, depth and blending, and restores them; it never
 * clears, because its quad covers every pixel of its rectangle: the image
 * where the plane has one, and the background elsewhere.
 */
import { Color3, Constants, Mesh, ShaderLanguage, ShaderMaterial, Vector2, Vector4, VertexData, type BaseTexture, type Scene } from "@babylonjs/core";
import { isBorrowedWebGpuEngine } from "@foss-earth/renderer/babylon";
import { rectanglePlanePointAt, type RectangleCamera, type RectangleExtent } from "./rectangleCamera.js";
import { RECTANGLE_SURFACE_FRAGMENT, RECTANGLE_SURFACE_SAMPLERS, RECTANGLE_SURFACE_UNIFORMS, RECTANGLE_SURFACE_VERTEX } from "./shaders.js";
import { RECTANGLE_SURFACE_FRAGMENT_GLSL, RECTANGLE_SURFACE_VERTEX_GLSL } from "./shadersWebGl.js";

/** A rectangle of the framebuffer, whole pixels from its top-left corner. */
export interface RectangleFramebufferRect { x: number; y: number; width: number; height: number }

/** An uploaded source, at the size it was uploaded. */
export interface RectangleSurfaceTexture {
  readonly texture: BaseTexture;
  readonly width: number;
  readonly height: number;
}

export type RectangleSampling = "linear" | "nearest";

/** What one surface draws this frame, read at draw time. */
export interface RectangleSurfaceDraw {
  readonly framebufferRect: RectangleFramebufferRect;
  /** Framebuffer pixels per CSS pixel, as measured on each axis. */
  readonly pixelsPerCss: { readonly x: number; readonly y: number };
  readonly extent: RectangleExtent;
  /** In the surface's CSS pixels from its top-left framebuffer edge. */
  readonly camera: RectangleCamera;
  /**
   * Which sides take part. A side that takes part with no texture yet is a
   * loading or failed region and shows the background.
   */
  readonly left: { readonly source: RectangleSurfaceTexture | null } | null;
  readonly right: { readonly source: RectangleSurfaceTexture | null } | null;
  /** 0 shows the right side only, 1 the left only; ignored with one side. */
  readonly wipe: number;
  readonly sampling: RectangleSampling;
  /** sRGB, 0 to 1. */
  readonly background: readonly [number, number, number];
}

/** The uniforms and viewport a draw uses, in float64 before upload. */
export interface RectangleSurfacePass {
  /** Babylon's viewport, whole framebuffer pixels from the bottom-left corner. */
  readonly viewport: RectangleFramebufferRect;
  /** The plane point at the surface's top-left corner, and the plane size it spans. */
  readonly planeRect: readonly [number, number, number, number];
  readonly wipe: number;
  readonly backgroundLinear: readonly [number, number, number];
}

const toLinear = (value: number): number => {
  const c = Math.min(1, Math.max(0, value));
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/**
 * A surface's viewport and uniforms for a framebuffer `framebufferHeight`
 * pixels tall, or null when nothing of it is on the framebuffer. With one
 * side the wipe is pinned so the whole surface shows that side.
 */
export function rectangleSurfacePass(draw: RectangleSurfaceDraw, framebufferWidth: number, framebufferHeight: number): RectangleSurfacePass | null {
  const { framebufferRect: rect, pixelsPerCss, camera } = draw;
  if (!(rect.width > 0 && rect.height > 0 && pixelsPerCss.x > 0 && pixelsPerCss.y > 0 && camera.scale > 0)) return null;
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > framebufferWidth || rect.y + rect.height > framebufferHeight) return null;
  const origin = rectanglePlanePointAt(camera, { x: 0, y: 0 });
  const wipe = draw.left && draw.right ? Math.min(1, Math.max(0, draw.wipe)) : draw.left ? 1 : 0;
  return {
    viewport: { x: rect.x, y: framebufferHeight - rect.y - rect.height, width: rect.width, height: rect.height },
    planeRect: [origin.x, origin.y, rect.width / pixelsPerCss.x / camera.scale, rect.height / pixelsPerCss.y / camera.scale],
    wipe,
    backgroundLinear: [toLinear(draw.background[0]), toLinear(draw.background[1]), toLinear(draw.background[2])],
  };
}

export interface RectangleSurfaceRendererOptions {
  requestRender(): void;
  /** A shader rejected by the device, or a draw that could not be made, once per distinct message. */
  onError?: (message: string) => void;
}

export interface RectangleSurfaceHandle {
  dispose(): void;
}

export interface RectangleSurfaceRenderer {
  readonly available: boolean;
  /** Why rectangle surfaces cannot be drawn here, or null. */
  readonly unavailableReason: string | null;
  /** Draws what `read` returns after the world each frame, in the order added; null draws nothing. */
  addSurface(read: () => RectangleSurfaceDraw | null): RectangleSurfaceHandle;
  dispose(): void;
}

type InternalEngine = {
  getRenderWidth(useScreen?: boolean): number;
  getRenderHeight(useScreen?: boolean): number;
  readonly currentViewport: { x: number; y: number; width: number; height: number } | null;
  setViewport(viewport: { x: number; y: number; width: number; height: number }, requiredWidth?: number, requiredHeight?: number): void;
  getDepthBuffer(): boolean;
  setDepthBuffer(enable: boolean): void;
  getDepthWrite(): boolean;
  setDepthWrite(enable: boolean): void;
  getAlphaMode(): number;
  setAlphaMode(mode: number, noDepthWriteChange?: boolean): void;
  getColorWrite(): boolean;
  setColorWrite(enable: boolean): void;
  enableScissor?(x: number, y: number, width: number, height: number): void;
  disableScissor?(): void;
};

/**
 * Rectangle surfaces need no fragment depth and no derivatives, only precision
 * enough for plane coordinates, so a context that cannot draw sphere orbs
 * may still draw them.
 */
export function createRectangleSurfaceRenderer(scene: Scene, options: RectangleSurfaceRendererOptions): RectangleSurfaceRenderer {
  const engine = scene.getEngine();
  const internal = engine as unknown as InternalEngine;
  const webGpu = isBorrowedWebGpuEngine(engine);
  const caps = engine.getCaps();
  const webGl2 = !webGpu && "webGLVersion" in engine && Number(engine.webGLVersion) >= 2;
  const unavailableReason = webGpu || caps.highPrecisionShaderSupported ? null
    : "This graphics context cannot draw image surfaces with the shader precision their coordinates need.";
  const available = unavailableReason === null;
  const backendDefines = webGpu ? [] : [
    ...(webGl2 ? ["#define SPHERE_WEBGL2"] : []),
    ...(webGl2 || (caps.standardDerivatives && caps.textureLOD) ? ["#define RECTANGLE_GRADIENTS"] : []),
  ];
  let disposed = false;
  const errors = new Set<string>();
  const report = (message: string): void => {
    if (disposed || errors.has(message)) return;
    errors.add(message);
    options.onError?.(message);
  };

  const mesh = new Mesh("rectangle-image-surface", scene);
  const quad = new VertexData();
  quad.positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
  quad.indices = [0, 1, 2, 0, 2, 3];
  quad.applyToMesh(mesh);
  mesh.isPickable = false;
  mesh.doNotSyncBoundingInfo = true;
  // Never drawn by a camera; only by the pass below.
  mesh.layerMask = 0;

  const materials = new Map<string, ShaderMaterial>();
  function materialFor(left: boolean, right: boolean): ShaderMaterial {
    const defines = [...(left ? ["#define RECTANGLE_LEFT"] : []), ...(right ? ["#define RECTANGLE_RIGHT"] : [])];
    const key = defines.join(" ");
    let material = materials.get(key);
    if (!material) {
      material = new ShaderMaterial(`rectangle-image-surface-${key || "empty"}`, scene, {
        vertexSource: webGpu ? RECTANGLE_SURFACE_VERTEX : RECTANGLE_SURFACE_VERTEX_GLSL,
        fragmentSource: webGpu ? RECTANGLE_SURFACE_FRAGMENT : RECTANGLE_SURFACE_FRAGMENT_GLSL,
      }, {
        attributes: ["position"],
        uniforms: [...RECTANGLE_SURFACE_UNIFORMS],
        samplers: [...RECTANGLE_SURFACE_SAMPLERS],
        defines: [...backendDefines, ...defines],
        shaderLanguage: webGpu ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
        needAlphaBlending: false,
      });
      material.backFaceCulling = false;
      material.disableDepthWrite = true;
      material.depthFunction = Constants.ALWAYS;
      material.onCompiled = () => { if (!disposed) options.requestRender(); };
      material.onError = (_effect, message) => report(message);
      materials.set(key, material);
    }
    return material;
  }

  const surfaces: { read: () => RectangleSurfaceDraw | null }[] = [];
  const planeRect = new Vector4(), extent = new Vector2(), leftSize = new Vector2(), rightSize = new Vector2(), background = new Color3();

  function drawSurface(draw: RectangleSurfaceDraw, width: number, height: number): void {
    const pass = rectangleSurfacePass(draw, width, height);
    if (!pass) return;
    const left = draw.left?.source ?? null, right = draw.right?.source ?? null;
    const material = materialFor(!!left, !!right);
    material.setVector4("planeRect", planeRect.set(...pass.planeRect));
    material.setVector2("extent", extent.set(draw.extent.width, draw.extent.height));
    material.setFloat("wipe", pass.wipe);
    material.setFloat("nearest", draw.sampling === "nearest" ? 1 : 0);
    material.setColor3("background", background.set(...pass.backgroundLinear));
    if (left) { material.setTexture("leftImage", left.texture); material.setVector2("leftSize", leftSize.set(left.width, left.height)); }
    if (right) { material.setTexture("rightImage", right.texture); material.setVector2("rightSize", rightSize.set(right.width, right.height)); }
    mesh.material = material;
    // Readiness checks every previously bound texture. Rebind first so a
    // disposed source, including one lost with its device, cannot keep the
    // cached material waiting after a ready replacement has been published.
    if (!material.isReady(mesh)) return;
    const { viewport } = pass;
    // Whole pixels, given as a fraction of 1 so Babylon does not multiply them by the render size.
    internal.setViewport(viewport, 1, 1);
    // WebGL's scissor is restored by disabling it, Babylon's own state outside a
    // scissored clear. A WebGPU render pass cannot have its scissor rectangle
    // reset by Babylon once set, so there the viewport alone bounds the quad.
    if (!webGpu) internal.enableScissor?.(viewport.x, viewport.y, viewport.width, viewport.height);
    try {
      mesh.directRender();
    } finally {
      if (!webGpu) internal.disableScissor?.();
    }
  }

  const observer = available ? scene.onAfterRenderObservable.add(() => {
    if (disposed || surfaces.length === 0) return;
    const width = internal.getRenderWidth(true), height = internal.getRenderHeight(true);
    // Only the canvas itself: a render target still bound here is not ours to draw into.
    if (internal.getRenderWidth() !== width || internal.getRenderHeight() !== height) {
      report("Image surfaces were skipped: a render target was still bound after the world was drawn.");
      return;
    }
    const draws: RectangleSurfaceDraw[] = [];
    for (const surface of surfaces) {
      const draw = surface.read();
      if (draw) draws.push(draw);
    }
    if (draws.length === 0) return;
    const viewport = internal.currentViewport;
    const depthTest = internal.getDepthBuffer(), depthWrite = internal.getDepthWrite();
    const alphaMode = internal.getAlphaMode(), colorWrite = internal.getColorWrite();
    internal.setDepthBuffer(false);
    internal.setDepthWrite(false);
    internal.setAlphaMode(Constants.ALPHA_DISABLE, true);
    internal.setColorWrite(true);
    try {
      for (const draw of draws) {
        try {
          drawSurface(draw, width, height);
        } catch (error) {
          report(`An image surface could not be drawn: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      if (viewport) internal.setViewport(viewport);
      internal.setDepthBuffer(depthTest);
      internal.setDepthWrite(depthWrite);
      internal.setAlphaMode(alphaMode, true);
      internal.setColorWrite(colorWrite);
    }
  }) : null;

  return {
    available,
    unavailableReason,
    addSurface(read) {
      const entry = { read };
      if (!disposed) surfaces.push(entry);
      if (!disposed) options.requestRender();
      return {
        dispose() {
          const index = surfaces.indexOf(entry);
          if (index < 0) return;
          surfaces.splice(index, 1);
          if (!disposed) options.requestRender();
        },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      surfaces.length = 0;
      if (observer) scene.onAfterRenderObservable.remove(observer);
      for (const material of materials.values()) material.dispose();
      materials.clear();
      mesh.dispose();
    },
  };
}
