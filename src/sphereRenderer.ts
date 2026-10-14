/**
 * Draws sphere image surfaces into their own measured rectangles of the shared
 * canvas (docs/proposals/shared-image-viewer-implementation.md §6, §7). Each
 * surface is one quad, drawn after the world, with no globe lease, no depth
 * and no tone mapping. The caller supplies the common view basis; each source
 * rotates that ray by its own content matrix once, in the shader. A pass sets
 * its viewport and restores the state it changed. It never clears.
 */
import { Color3, Constants, Mesh, ShaderLanguage, ShaderMaterial, Vector2, Vector3, Vector4, VertexData, type BaseTexture, type Scene } from "@babylonjs/core";
import { isBorrowedWebGpuEngine } from "@foss-earth/renderer/babylon";
import type { Mat3, Vec3 } from "@foss-earth/images";
import type { ViewBasis } from "./math.js";
import { SPHERE_SURFACE_FRAGMENT, SPHERE_SURFACE_VERTEX } from "./shaders.js";
import { SPHERE_SURFACE_FRAGMENT_GLSL, SPHERE_SURFACE_VERTEX_GLSL } from "./shadersWebGl.js";

/** A rectangle of the framebuffer, whole pixels from its top-left corner. */
export interface SphereFramebufferRect { x: number; y: number; width: number; height: number }

export type SphereSampling = "linear" | "nearest";

export type SphereSurfaceKind = "cube" | "equirectangular" | "tiles";

/** A tiled cube's GPU side: the preview is the source texture, and these are the refinement. */
export interface SphereSurfaceTiles {
  readonly atlas: BaseTexture;
  readonly table: BaseTexture;
  /** Cells along a face side, a tile's logical texels, its gutter and its stored side. */
  readonly layout: readonly [number, number, number, number];
  /** The atlas's width and height, texels. */
  readonly atlasSize: readonly [number, number];
  readonly warp: "equi-angular" | "gnomonic";
  /** Draws each tile's edges, tinted by its level; read at every draw. */
  readonly outlines: boolean;
}

/**
 * One source in a comparison slot. `contentFromCommon` is applied once, in the
 * shader, to the common ray. This is not the live source/next crossfade.
 */
export interface SphereSurfaceSource {
  readonly texture: BaseTexture;
  readonly kind: SphereSurfaceKind;
  /** Image width and height, texels. Equirectangular sampling uses it to snap to texel centres. */
  readonly width: number;
  readonly height: number;
  readonly contentFromCommon: Mat3;
  /** For kind "tiles": the preview is `texture`, and a cell with no resident tile shows it. */
  readonly tiles?: SphereSurfaceTiles;
}

/** What one surface draws this frame, read at draw time. */
export interface SphereSurfaceDraw {
  readonly framebufferRect: SphereFramebufferRect;
  /** The common view, already converted from the measured CSS viewport. */
  readonly basis: ViewBasis;
  readonly left: { readonly source: SphereSurfaceSource | null } | null;
  readonly right: { readonly source: SphereSurfaceSource | null } | null;
  /** 0 shows the right side only, 1 the left only; ignored with one side. */
  readonly wipe: number;
  readonly sampling: SphereSampling;
  /** sRGB, 0 to 1. */
  readonly background: readonly [number, number, number];
}

export interface SphereSurfacePass {
  /** Babylon's viewport, whole framebuffer pixels from the bottom-left corner. */
  readonly viewport: SphereFramebufferRect;
  readonly forward: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  /** tan(vertical FOV / 2), computed in float64. */
  readonly tanHalf: number;
  readonly aspect: number;
  readonly wipe: number;
  readonly backgroundLinear: readonly [number, number, number];
}

export interface SphereSurfaceVariant {
  readonly defines: readonly string[];
  readonly uniforms: readonly string[];
  readonly samplers: readonly string[];
}

const BASE_UNIFORMS = ["forward", "right", "up", "tanHalf", "aspect", "wipe", "nearest", "background"] as const;

const toLinear = (value: number): number => {
  const c = Math.min(1, Math.max(0, value));
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

function sideVariant(side: "left" | "right", kind: SphereSurfaceKind | null): SphereSurfaceVariant {
  if (!kind) return { defines: [], uniforms: [], samplers: [] };
  const content = [`${side}Content0`, `${side}Content1`, `${side}Content2`];
  if (kind === "equirectangular") {
    return { defines: [`#define ${side.toUpperCase()}_EQUIRECT`], uniforms: [...content, `${side}Size`], samplers: [`${side}Equirect`] };
  }
  if (kind === "cube") return { defines: [`#define ${side.toUpperCase()}_CUBE`], uniforms: content, samplers: [`${side}Cube`] };
  return {
    defines: [`#define ${side.toUpperCase()}_CUBE`, `#define ${side.toUpperCase()}_TILES`],
    uniforms: [...content, `${side}TileLayout`, `${side}TileAtlasInfo`],
    samplers: [`${side}Cube`, `${side}TileAtlas`, `${side}TileTable`],
  };
}

/** The shader variant for two slots. A steady tiled pair names exactly six samplers, and no others. */
export function sphereSurfaceVariant(left: SphereSurfaceKind | null, right: SphereSurfaceKind | null): SphereSurfaceVariant {
  const a = sideVariant("left", left), b = sideVariant("right", right);
  return {
    defines: [...a.defines, ...b.defines],
    uniforms: [...BASE_UNIFORMS, ...a.uniforms, ...b.uniforms],
    samplers: [...a.samplers, ...b.samplers],
  };
}

/**
 * A surface's viewport and the basis it uploads, or null when nothing of it is
 * on the framebuffer or the basis cannot cast a ray. With one side the wipe is
 * pinned so the whole surface shows that side.
 */
export function sphereSurfacePass(draw: SphereSurfaceDraw, framebufferWidth: number, framebufferHeight: number): SphereSurfacePass | null {
  const { framebufferRect: rect, basis } = draw;
  if (!(rect.width > 0 && rect.height > 0)) return null;
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > framebufferWidth || rect.y + rect.height > framebufferHeight) return null;
  const tanHalf = Math.tan(basis.verticalFovRad / 2);
  if (!(tanHalf > 0) || !(basis.aspect > 0) || !Number.isFinite(tanHalf)) return null;
  const wipe = draw.left && draw.right ? Math.min(1, Math.max(0, draw.wipe)) : draw.left ? 1 : 0;
  return {
    viewport: { x: rect.x, y: framebufferHeight - rect.y - rect.height, width: rect.width, height: rect.height },
    forward: basis.forward, right: basis.right, up: basis.up, tanHalf, aspect: basis.aspect, wipe,
    backgroundLinear: [toLinear(draw.background[0]), toLinear(draw.background[1]), toLinear(draw.background[2])],
  };
}

export interface SphereSurfaceRendererOptions {
  requestRender(): void;
  /** A shader rejected by the device, or a draw that could not be made, once per distinct message. */
  onError?: (message: string) => void;
}

export interface SphereSurfaceHandle { dispose(): void }

export interface SphereSurfaceRenderer {
  readonly available: boolean;
  /** Why sphere surfaces cannot be drawn here, or null. */
  readonly unavailableReason: string | null;
  /** Draws what `read` returns after the world each frame, in the order added; null draws nothing. */
  addSurface(read: () => SphereSurfaceDraw | null): SphereSurfaceHandle;
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
 * Sphere surfaces need no fragment depth and no globe. Precision enough for
 * the uploaded basis is the requirement; derivatives improve equirectangular
 * seams when the context has them and are not demanded when it does not.
 */
export function createSphereSurfaceRenderer(scene: Scene, options: SphereSurfaceRendererOptions): SphereSurfaceRenderer {
  const engine = scene.getEngine();
  const internal = engine as unknown as InternalEngine;
  const webGpu = isBorrowedWebGpuEngine(engine);
  const caps = engine.getCaps();
  const webGl2 = !webGpu && "webGLVersion" in engine && Number(engine.webGLVersion) >= 2;
  const unavailableReason = webGpu || caps.highPrecisionShaderSupported ? null
    : "This graphics context cannot draw sphere surfaces with the shader precision their coordinates need.";
  const available = unavailableReason === null;
  const backendDefines = webGpu ? [] : [
    ...(webGl2 ? ["#define SPHERE_WEBGL2"] : []),
    ...(webGl2 || (caps.standardDerivatives && caps.textureLOD) ? ["#define SPHERE_TEXTURE_GRADIENTS"] : []),
  ];
  let disposed = false;
  const errors = new Set<string>();
  const report = (message: string): void => {
    if (disposed || errors.has(message)) return;
    errors.add(message);
    options.onError?.(message);
  };

  const mesh = new Mesh("sphere-image-surface", scene);
  const quad = new VertexData();
  quad.positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
  quad.indices = [0, 1, 2, 0, 2, 3];
  quad.applyToMesh(mesh);
  mesh.isPickable = false;
  mesh.doNotSyncBoundingInfo = true;
  mesh.layerMask = 0;

  const materials = new Map<string, ShaderMaterial>();
  function materialFor(left: SphereSurfaceKind | null, right: SphereSurfaceKind | null): ShaderMaterial {
    const variant = sphereSurfaceVariant(left, right);
    const key = variant.defines.join(" ") || "empty";
    let material = materials.get(key);
    if (!material) {
      material = new ShaderMaterial(`sphere-image-surface-${key}`, scene, {
        vertexSource: webGpu ? SPHERE_SURFACE_VERTEX : SPHERE_SURFACE_VERTEX_GLSL,
        fragmentSource: webGpu ? SPHERE_SURFACE_FRAGMENT : SPHERE_SURFACE_FRAGMENT_GLSL,
      }, {
        attributes: ["position"],
        uniforms: [...variant.uniforms],
        samplers: [...variant.samplers],
        defines: [...backendDefines, ...variant.defines],
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

  const surfaces: { read: () => SphereSurfaceDraw | null }[] = [];
  const forwardAxis = new Vector3(), rightAxis = new Vector3(), upAxis = new Vector3(), background = new Color3();
  const leftSize = new Vector2(), rightSize = new Vector2();
  const leftLayout = new Vector4(), rightLayout = new Vector4(), leftAtlas = new Vector4(), rightAtlas = new Vector4();
  // One vector per uniform. A shared vector would make every row the last one written if the bind reads it later.
  const contentVectors = { left: [new Vector3(), new Vector3(), new Vector3()], right: [new Vector3(), new Vector3(), new Vector3()] };

  function bindSource(material: ShaderMaterial, side: "left" | "right", source: SphereSurfaceSource): void {
    source.contentFromCommon.forEach((row, index) => {
      const vector = contentVectors[side][index]!;
      material.setVector3(`${side}Content${index}`, vector.set(row[0], row[1], row[2]));
    });
    if (source.kind === "equirectangular") {
      material.setTexture(`${side}Equirect`, source.texture);
      const size = side === "left" ? leftSize : rightSize;
      material.setVector2(`${side}Size`, size.set(source.width, source.height));
      return;
    }
    material.setTexture(`${side}Cube`, source.texture);
    const tiles = source.tiles;
    if (source.kind !== "tiles" || !tiles) return;
    material.setTexture(`${side}TileAtlas`, tiles.atlas);
    material.setTexture(`${side}TileTable`, tiles.table);
    const layout = side === "left" ? leftLayout : rightLayout;
    const atlas = side === "left" ? leftAtlas : rightAtlas;
    material.setVector4(`${side}TileLayout`, layout.set(tiles.layout[0], tiles.layout[1], tiles.layout[2], tiles.layout[3]));
    material.setVector4(`${side}TileAtlasInfo`, atlas.set(tiles.atlasSize[0], tiles.atlasSize[1], tiles.warp === "equi-angular" ? 1 : 0, tiles.outlines ? 1 : 0));
  }

  function drawSurface(draw: SphereSurfaceDraw, width: number, height: number): void {
    const pass = sphereSurfacePass(draw, width, height);
    if (!pass) return;
    const left = draw.left?.source ?? null, right = draw.right?.source ?? null;
    const material = materialFor(left?.kind ?? null, right?.kind ?? null);
    material.setVector3("forward", forwardAxis.set(pass.forward[0], pass.forward[1], pass.forward[2]));
    material.setVector3("right", rightAxis.set(pass.right[0], pass.right[1], pass.right[2]));
    material.setVector3("up", upAxis.set(pass.up[0], pass.up[1], pass.up[2]));
    material.setFloat("tanHalf", pass.tanHalf);
    material.setFloat("aspect", pass.aspect);
    material.setFloat("wipe", pass.wipe);
    material.setFloat("nearest", draw.sampling === "nearest" ? 1 : 0);
    material.setColor3("background", background.set(...pass.backgroundLinear));
    if (left) bindSource(material, "left", left);
    if (right) bindSource(material, "right", right);
    mesh.material = material;
    // Readiness checks every previously bound texture. Rebind first so a
    // disposed source cannot keep the cached material waiting after a ready
    // replacement has been published.
    if (!material.isReady(mesh)) return;
    const { viewport } = pass;
    internal.setViewport(viewport, 1, 1);
    // WebGL's scissor is restored by disabling it. WebGPU cannot reset a pass
    // scissor, so the viewport alone bounds that quad. A context with no GL
    // handle, such as the null engine, has nothing to scissor.
    const gl = (engine as { _gl?: object | null })._gl;
    if (!webGpu && gl) internal.enableScissor?.(viewport.x, viewport.y, viewport.width, viewport.height);
    try {
      mesh.directRender();
    } finally {
      if (!webGpu && gl) internal.disableScissor?.();
    }
  }

  const observer = available ? scene.onAfterRenderObservable.add(() => {
    if (disposed || surfaces.length === 0) return;
    const width = internal.getRenderWidth(true), height = internal.getRenderHeight(true);
    if (internal.getRenderWidth() !== width || internal.getRenderHeight() !== height) {
      report("Sphere surfaces were skipped: a render target was still bound after the world was drawn.");
      return;
    }
    const draws: SphereSurfaceDraw[] = [];
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
          report(`A sphere surface could not be drawn: ${error instanceof Error ? error.message : String(error)}`);
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
