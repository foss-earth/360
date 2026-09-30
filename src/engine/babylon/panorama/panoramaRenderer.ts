/**
 * Draws panorama orbs over the globe and the immersive view
 * (docs/proposals/panorama-scenes.md §3): each orb is a quad whose
 * fragments cast the camera's own rays at a sphere, with depth where the ray
 * meets it, so terrain in front hides it; immersion is one triangle covering
 * the view. Every frame's uniforms are computed from the camera as it is for
 * that frame, in float64 on the CPU, immediately before the mesh draws.
 *
 * WebGPU and WebGL use the same geometry and analytic depth. WebGL 1 needs
 * fragment depth and standard derivatives to preserve that contract.
 */
import {
  Color4,
  Constants,
  Matrix,
  Mesh,
  RawTexture,
  RenderTargetTexture,
  ShaderLanguage,
  ShaderMaterial,
  VertexData,
  type BaseTexture,
  type Camera,
  type Observer,
  type Scene,
} from "@babylonjs/core";
import {
  add,
  cross,
  dot,
  length,
  normalize,
  scale,
  sub,
  type Mat3,
  type Vec3,
  type ViewBasis,
} from "../../../scenes/panoramaMath";
import type { FrameProfiler } from "../../../perf/frameProfiler";
import { NAVIGATION_PRESENTATION_LAYER, type NavigationPresentation } from "../navigationLease";
import {
  IMMERSION_FRAGMENT,
  IMMERSION_UNIFORMS,
  IMMERSION_VERTEX,
  ORB_FRAGMENT,
  ORB_UNIFORMS,
  ORB_VERTEX,
} from "./panoramaShaders";
import { IMMERSION_FRAGMENT_GLSL, IMMERSION_LEAN_UNIFORMS, IMMERSION_VERTEX_GLSL, ORB_FRAGMENT_GLSL, ORB_LEAN_UNIFORMS, ORB_VERTEX_GLSL } from "./panoramaShadersWebGL";
import { isWebGpuEngine } from "./panoramaTextures";

/** One frame's camera, as the globe is drawn with it: eye in float64 ECEF and the rotation-and-projection matrix. */
export interface PanoramaCameraFrame {
  eye: Vec3;
  viewRotProj: Matrix;
  inverseViewRotProj: Matrix;
  view: ViewBasis;
  viewportHeightCssPx: number;
  /** A digest of the camera state, to correlate a frame's draws with its camera. */
  readonly revision: string;
}

export interface OrbAppearance {
  /** Full angle of the flat window, degrees: `scene.panorama.previewFov`. */
  previewFovDeg: number;
  /** Effective radius bounds as projected diameters, CSS px: `scene.panorama.markerDiameter`. */
  markerDiameterCssPx: { min: number; max: number };
  /** Pointer tolerance, CSS px: `scene.panorama.hitTargetDiameter`. */
  hitTargetDiameterCssPx: number;
}

export interface OrbState {
  /** Marker centre in ECEF, float64; null while its placement is pending. */
  marker: Vec3 | null;
  /** Authored or fallback radius, metres, before screen-size bounds. */
  radiusMeters: number;
  /** ECEF → image-local rotation. */
  content: Mat3;
  texture: BaseTexture | null;
  visible: boolean;
  /** A ring just outside the silhouette: sRGB and alpha 0–1, width in CSS px; null draws none. */
  outline: { color: readonly [number, number, number, number]; widthPx: number } | null;
  /** Multiplies the radius after the screen-size bounds, as a hover grows the orb: 1 normally. */
  displayScale: number;
}

export interface OrbExpansion {
  /** The virtual radius the orb and its overlay draw with, metres. */
  radiusMeters: number;
  /** 0: clipped by terrain like the orb; 1: drawn over everything. */
  reveal: number;
  /** The image the overlay draws instead of the orb's preview, as a flight out of the panorama on screen starts from it. */
  source?: ImmersionSource | null;
}

export interface PanoramaOrb {
  readonly id: string;
  update(state: Partial<OrbState>): void;
  /** Draws the orb as a sphere of the expansion's radius, with its overlay over everything, or stops with null. */
  setExpansion(expansion: OrbExpansion | null): void;
  /** The radius used this frame for silhouette, depth and picking. */
  effectiveRadius(frame?: PanoramaCameraFrame): number | null;
  dispose(): void;
}

export interface ImmersionSource {
  texture: BaseTexture;
  kind: "cube" | "equirectangular";
  content: Mat3;
}

export interface PanoramaImmersion {
  /**
   * Draws `source` full screen; `next` blends in by `mix` for a crossfade.
   * `view` draws it with that view while the globe camera's still shows
   * behind it, as in a fade; without it the lease's presentation or the
   * globe camera's view is used. Null hides it.
   */
  show(state: { source: ImmersionSource; next?: ImmersionSource | null; mix?: number; opacity?: number; view?: NavigationPresentation | null } | null): void;
  readonly visible: boolean;
}

export interface OrbHit {
  id: string;
  /** Metres from the eye to the sphere's near surface. */
  depthMeters: number;
  /** Whether the ray met the silhouette itself or only the enlarged pointer target. */
  onSilhouette: boolean;
}

export type PanoramaProbeOutput = "direction" | "ray";

export interface PanoramaProbeResult {
  width: number;
  height: number;
  /** Per output asked for, RGBA float32 rows as read back: xyz and coverage. */
  outputs: Partial<Record<PanoramaProbeOutput, Float32Array>>;
  /** The camera frame every output was drawn with: one frame for all. */
  frame: PanoramaCameraFrame;
}

/**
 * Changes meant to draw the same picture with less work, off until validated
 * (docs/validation/panorama-experiments.md). Each is a renderer.experiments.* parameter.
 */
export interface PanoramaRendererExperiments {
  /** Draw records, camera revisions and earlier frames' uniforms only while a check captures or delays. */
  bookkeeping: boolean;
  /** Immersion at full opacity drawn without blending. */
  opaqueImmersion: boolean;
  /** WebGL: the PANORAMA_LEAN shaders. WebGPU draws as before. */
  shaders: boolean;
}

export const NO_PANORAMA_EXPERIMENTS: Readonly<PanoramaRendererExperiments> = { bookkeeping: false, opaqueImmersion: false, shaders: false };

export interface PanoramaRenderer {
  readonly available: boolean;
  /** Why panoramas cannot be drawn, or null. */
  readonly unavailableReason: string | null;
  addOrb(id: string, state: OrbState): PanoramaOrb;
  readonly immersion: PanoramaImmersion;
  setAppearance(appearance: OrbAppearance): void;
  /** The camera frame the next draw uses: the presentation view when one is set, or `view`. */
  cameraFrame(view?: NavigationPresentation | null): PanoramaCameraFrame | null;
  /** Orbs under a canvas point (CSS px), nearest first, then by id; occluded ones left out by the caller's test. */
  pick(clientX: number, clientY: number, isOccluded: (eye: Vec3, direction: Vec3, distance: number) => boolean): OrbHit[];
  /** Where a world direction from the eye lands on the canvas, CSS px, or null behind the view. */
  project(direction: Vec3, frame?: PanoramaCameraFrame): { x: number; y: number } | null;
  /**
   * Test only: renders what `target` shows as float vectors and reads them
   * back, each output in its own render target within one rendered frame:
   * the view ray each pixel drew with, and the image direction it sampled.
   */
  probe(target: { orb: string } | { immersion: true }, outputs: readonly PanoramaProbeOutput[]): Promise<PanoramaProbeResult>;
  /** Turns the work-saving experiments on or off; what is left out keeps its value. */
  setExperiments(experiments: Partial<PanoramaRendererExperiments>): void;
  /** Test only: draw with uniforms this many frames old (the negative control). */
  setUniformDelayFrames(frames: number): void;
  /**
   * Test only: keeps draw records even when the bookkeeping experiment leaves
   * them out. Without that experiment they are always kept.
   */
  captureDraws(capture: boolean): void;
  /** Test only: the last frames' camera and uniform revisions, to show no draw used a stale camera. */
  drawRecords(): readonly { frameId: number; target: string; cameraRevision: string; uniformRevision: string }[];
  /** Test only: what an orb draws from, and its radius in `frame`, for a CPU reference to use the same inputs. */
  inspectOrb(id: string, frame?: PanoramaCameraFrame): { marker: Vec3 | null; radiusMeters: number; effectiveRadius: number | null; content: Mat3; visible: boolean; textured: boolean } | null;
  dispose(): void;
}

// ─── Pure geometry ─────────────────────────────────────────────────────

/**
 * The quad an orb draws: perpendicular to the axis, or across the view when
 * the sphere is near or around the eye. `marginCssPx` more beyond the
 * silhouette leaves room for an outline.
 */
export function orbQuad(rel: Vec3, radius: number, frame: Pick<PanoramaCameraFrame, "view" | "viewportHeightCssPx">, nearPlane: number, marginCssPx = 0): { center: Vec3; u: Vec3; v: Vec3; fullscreen: boolean } {
  const d = length(rel);
  const { view } = frame;
  const tanHalf = Math.tan(view.verticalFovRad / 2);
  // Beyond 80° from its centre the cap's quad would be huge; cover the view instead.
  const fullscreen = d <= radius * 1.02 || radius / d > Math.sin((80 * Math.PI) / 180);
  if (fullscreen) {
    const s = Math.max(nearPlane * 1.5, 1e-3);
    return {
      center: scale(view.forward, s),
      u: scale(view.right, s * tanHalf * view.aspect * 1.05),
      v: scale(view.up, s * tanHalf * 1.05),
      fullscreen,
    };
  }
  const a = scale(rel, 1 / d);
  const alpha = Math.asin(radius / d);
  // Three pixels beyond the silhouette leave room for its antialiased edge.
  const pixel = (d * 2 * tanHalf) / Math.max(1, frame.viewportHeightCssPx);
  const half = d * Math.tan(alpha) + (3 + marginCssPx) * pixel;
  const helper = Math.abs(dot(a, view.up)) < 0.9 ? view.up : view.right;
  const u = normalize(cross(a, helper));
  const v = cross(u, a);
  return { center: rel, u: scale(u, half), v: scale(v, half), fullscreen };
}

/** The radius that keeps an orb's projected diameter within the marker bounds, metres. */
export function effectiveOrbRadius(radiusMeters: number, distance: number, frame: Pick<PanoramaCameraFrame, "view" | "viewportHeightCssPx">, bounds: { min: number; max: number }): number {
  const tanHalf = Math.tan(frame.view.verticalFovRad / 2);
  const metresPerPixel = (distance * 2 * tanHalf) / Math.max(1, frame.viewportHeightCssPx);
  const low = (bounds.min / 2) * metresPerPixel;
  const high = (bounds.max / 2) * metresPerPixel;
  return Math.min(Math.max(radiusMeters, low), Math.max(low, high));
}

function basisFromViewMatrix(view: Matrix): { forward: Vec3; right: Vec3; up: Vec3 } {
  const m = view.m;
  return {
    right: normalize([m[0], m[4], m[8]]),
    up: normalize([m[1], m[5], m[9]]),
    forward: normalize([-m[2], -m[6], -m[10]]),
  };
}

function rotationOnly(view: Matrix): Matrix {
  const m = view.m;
  return Matrix.FromValues(m[0], m[1], m[2], 0, m[4], m[5], m[6], 0, m[8], m[9], m[10], 0, 0, 0, 0, 1);
}

/** The right-handed view rotation of a presentation's forward and up. */
function presentationRotation(presentation: NavigationPresentation): { matrix: Matrix; basis: { forward: Vec3; right: Vec3; up: Vec3 } } {
  const forward = normalize([presentation.forward.x, presentation.forward.y, presentation.forward.z]);
  const right = normalize(cross(forward, [presentation.up.x, presentation.up.y, presentation.up.z]));
  const up = cross(right, forward);
  const matrix = Matrix.FromValues(
    right[0], up[0], -forward[0], 0,
    right[1], up[1], -forward[1], 0,
    right[2], up[2], -forward[2], 0,
    0, 0, 0, 1,
  );
  return { matrix, basis: { forward, right, up } };
}

const toVector = (v: Vec3) => ({ x: v[0], y: v[1], z: v[2] });
/** Babylon's own default near plane, used only if the scene has no camera. */
const NEAR_PLANE_WITHOUT_CAMERA = 0.1;

// ─── Renderer ──────────────────────────────────────────────────────────

export interface PanoramaRendererOptions {
  /** The lease's presented view, read at draw time. */
  getPresentationView(): NavigationPresentation | null;
  requestRender(): void;
  /** A shader rejected by the device, once per distinct diagnostic, for the host's log. */
  onError?: (message: string) => void;
  /** Where preparing each draw's direction and parameters is timed, inside the draw phase. */
  profiler?: Pick<FrameProfiler, "clock" | "add">;
  /** The experiments to start with; all off when omitted. */
  experiments?: Partial<PanoramaRendererExperiments>;
}

/** The lean shaders' marker: the variant is chosen per material by this define. */
const LEAN_DEFINE = "#define PANORAMA_LEAN";

/** A digest of a camera frame's inputs, to correlate a draw with its camera. */
function frameRevision(eye: Vec3, basis: { forward: Vec3; up: Vec3 }, verticalFovRad: number, aspect: number): string {
  return [...eye, ...basis.forward, ...basis.up, verticalFovRad, aspect].map(value => value.toPrecision(12)).join(",");
}

/**
 * An orb's per-draw constants, in float64, as the lean orb shader takes
 * them: its cap angle and flat window, which its fragments would otherwise
 * each work out from the marker, the radius and the preview's angle. The
 * distance and depth stay per fragment, in the shader's own arithmetic.
 */
export function orbDrawConstants(rel: Vec3, radius: number, tanPreviewHalfAngle: number): { sinAlpha: number; windowGain: number; identityWindow: boolean } {
  const distance = length(rel);
  const sinAlpha = Math.min(radius / distance, 1);
  const cosAlpha = Math.sqrt(Math.max(1 - sinAlpha * sinAlpha, 0));
  const tanAlpha = sinAlpha / Math.max(cosAlpha, 1e-7);
  return {
    sinAlpha,
    windowGain: tanPreviewHalfAngle / Math.max(tanAlpha, 1e-7),
    identityWindow: distance <= radius || tanAlpha >= tanPreviewHalfAngle,
  };
}

/**
 * The lean immersion's matrix from clip space to a ray in an image's frame:
 * the inverse view-and-projection, then the image's rotation, divided by the
 * ray's w. w is the same at every corner of the view (clip z and w are, and
 * a perspective's w does not depend on x or y), so the division is exact
 * across the triangle and the vertex shader needs none.
 */
export function imageFromClipMatrix(inverseViewRotProj: Matrix, content: Mat3, result: Matrix): Matrix {
  const m = inverseViewRotProj.m;
  // The ray's w at clip (0, 0, 0.5, 1); Babylon's row vectors: v' = v · M.
  const w = 0.5 * m[11] + m[15];
  const values: number[] = new Array(16);
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 3; column++) {
      const image = content[column];
      values[row * 4 + column] = (m[row * 4] * image[0] + m[row * 4 + 1] * image[1] + m[row * 4 + 2] * image[2]) / w;
    }
    values[row * 4 + 3] = m[row * 4 + 3] / w;
  }
  return Matrix.FromArrayToRef(values, 0, result);
}

/** Nested under profileBabylonScene's draw phase, which these draws run in. */
const UNIFORMS_SECTION = "render/draw/panorama uniforms";

export function createPanoramaRenderer(scene: Scene, options: PanoramaRendererOptions): PanoramaRenderer {
  const engine = scene.getEngine();
  const webGpu = isWebGpuEngine(engine);
  const caps = engine.getCaps();
  const unavailableReason = webGpu ? null
    : !caps.fragmentDepthSupported ? "This graphics context cannot draw panorama depth. WebGL 1 needs the EXT_frag_depth extension."
      : !caps.standardDerivatives ? "This graphics context cannot draw panorama edges. WebGL 1 needs the OES_standard_derivatives extension."
        : !caps.highPrecisionShaderSupported ? "This graphics context cannot draw panoramas with the required shader precision."
          : null;
  const available = unavailableReason === null;
  const webGl2 = !webGpu && "webGLVersion" in engine && Number(engine.webGLVersion) >= 2;
  const backendDefines = webGpu ? [] : [
    ...(webGl2 ? ["#define PANORAMA_WEBGL2"] : []),
    ...(webGl2 || caps.textureLOD ? ["#define PANORAMA_TEXTURE_GRADIENTS"] : []),
  ];
  const shaderLanguage = webGpu ? ShaderLanguage.WGSL : ShaderLanguage.GLSL;
  let appearance: OrbAppearance = { previewFovDeg: 90, markerDiameterCssPx: { min: 24, max: 96 }, hitTargetDiameterCssPx: 44 };
  const experiments: PanoramaRendererExperiments = { ...NO_PANORAMA_EXPERIMENTS, ...options.experiments };
  /** The lean shaders exist in GLSL only. */
  const leanShaders = (): boolean => experiments.shaders && !webGpu;
  let captureDraws = false;
  /** Whether draws are recorded and their camera frames kept for the negative control. */
  const keepingRecords = (): boolean => !experiments.bookkeeping || captureDraws;
  let delayFrames = 0;
  const records: { frameId: number; target: string; cameraRevision: string; uniformRevision: string }[] = [];
  const orbs = new Map<string, OrbInternal>();
  let disposed = false;
  // The globe may sleep while an asynchronously compiled shader finishes.
  // Its first usable frame must not wait for another camera or map update.
  const onCompiled = (): void => { if (!disposed) options.requestRender(); };
  const shaderErrors = new Set<string>();
  const onError: NonNullable<ShaderMaterial["onError"]> = (_effect, message) => {
    if (disposed || shaderErrors.has(message)) return;
    shaderErrors.add(message);
    options.onError?.(message);
  };
  const profiler = options.profiler;
  /** Times a draw's preparation in the frame budget. */
  const timed = (prepare: () => void) => (): void => {
    const started = profiler?.clock() ?? 0;
    prepare();
    if (started) profiler!.add(UNIFORMS_SECTION, started);
  };

  function canvasCssHeight(): number {
    const canvas = engine.getRenderingCanvas();
    return canvas?.clientHeight || engine.getRenderHeight() || 1;
  }

  /** The camera the globe is drawn with this frame, or the presentation that replaces its view. */
  function currentFrame(presentation = options.getPresentationView()): PanoramaCameraFrame | null {
    const camera: Camera | null = scene.activeCamera;
    if (!camera) return null;
    // The eye is updated with the view matrix: bring both up to date before reading either.
    const view = camera.getViewMatrix();
    const position = camera.globalPosition;
    const eye: Vec3 = [position.x, position.y, position.z];
    const aspect = engine.getAspectRatio(camera);
    let rotation: Matrix;
    let projection: Matrix;
    let basis: { forward: Vec3; right: Vec3; up: Vec3 };
    let verticalFovRad: number;
    if (presentation) {
      const presented = presentationRotation(presentation);
      rotation = presented.matrix;
      basis = presented.basis;
      verticalFovRad = presentation.verticalFovRad;
      projection = Matrix.PerspectiveFovRH(verticalFovRad, aspect, 0.1, 1000, engine.isNDCHalfZRange);
    } else {
      rotation = rotationOnly(view);
      basis = basisFromViewMatrix(view);
      verticalFovRad = camera.fov;
      projection = camera.getProjectionMatrix();
    }
    const viewRotProj = rotation.multiply(projection);
    const inverseViewRotProj = viewRotProj.clone().invert();
    const frame = {
      eye,
      viewRotProj,
      inverseViewRotProj,
      view: { ...basis, verticalFovRad, aspect },
      viewportHeightCssPx: canvasCssHeight(),
    };
    if (!experiments.bookkeeping) return { ...frame, revision: frameRevision(eye, basis, verticalFovRad, aspect) };
    // Formatted only when something reads it: a check's records, never an ordinary draw.
    let revision: string | null = null;
    return Object.defineProperty(frame, "revision", {
      get: () => (revision ??= frameRevision(eye, basis, verticalFovRad, aspect)),
      enumerable: true,
    }) as PanoramaCameraFrame;
  }

  /** What the camera frame depends on, cheaply: the camera, its matrices' versions, the aspect and the canvas height. */
  function cameraKey(): string {
    const camera = scene.activeCamera;
    if (!camera) return "";
    return `${camera.uniqueId}:${camera.getViewMatrix().updateFlag}:${camera.getProjectionMatrix().updateFlag}:${engine.getAspectRatio(camera)}:${canvasCssHeight()}`;
  }
  /** The same inputs as cameraKey, compared in place without building a string for every draw. */
  const lastCameraInputs = { camera: -1, view: -1, projection: -1, aspect: Number.NaN, height: Number.NaN };
  function cameraInputsChanged(): boolean {
    const camera = scene.activeCamera;
    const id = camera?.uniqueId ?? -1;
    const view = camera ? camera.getViewMatrix().updateFlag : -1;
    const projection = camera ? camera.getProjectionMatrix().updateFlag : -1;
    const aspect = camera ? engine.getAspectRatio(camera) : 0;
    const height = camera ? canvasCssHeight() : 0;
    const last = lastCameraInputs;
    const changed = last.camera !== id || last.view !== view || last.projection !== projection || last.aspect !== aspect || last.height !== height;
    last.camera = id;
    last.view = view;
    last.projection = projection;
    last.aspect = aspect;
    last.height = height;
    return changed;
  }

  // The frame every draw uses, and, for the negative control, one per earlier
  // rendered frame. It is computed again whenever the camera or the presented
  // view changed since, even within one rendered frame, so a draw never uses a
  // camera from before a move.
  let frameCache: { id: number; key: string; presentation: NavigationPresentation | null; frame: PanoramaCameraFrame | null } | null = null;
  const history: PanoramaCameraFrame[] = [];
  let historyFrameId = -1;
  function drawFrame(): { current: PanoramaCameraFrame; uniforms: PanoramaCameraFrame } | null {
    const id = engine.frameId;
    const presentation = options.getPresentationView();
    const lean = experiments.bookkeeping;
    const key = lean ? "" : cameraKey();
    // Always evaluated, so the inputs it keeps are this draw's.
    const inputsChanged = lean && cameraInputsChanged();
    if (!frameCache || frameCache.id !== id || frameCache.key !== key || inputsChanged || frameCache.presentation !== presentation) {
      const frame = currentFrame(presentation);
      frameCache = { id, key, presentation, frame };
      if (!frame) {
        // Nothing to keep.
      } else if (lean && delayFrames === 0) {
        // Without a delay only this frame is read; the history waits for a check that asks for one.
        history.length = 0;
        historyFrameId = -1;
      } else {
        // A camera moved within a rendered frame replaces that frame's entry.
        if (historyFrameId === id && history.length > 0) history[0] = frame;
        else {
          history.unshift(frame);
          history.length = Math.min(history.length, 8);
          historyFrameId = id;
        }
      }
    }
    const current = frameCache.frame;
    if (!current) return null;
    const uniforms = history[Math.min(delayFrames, history.length - 1)] ?? current;
    return { current, uniforms };
  }

  function record(target: string, current: PanoramaCameraFrame, uniforms: PanoramaCameraFrame): void {
    if (!keepingRecords()) return;
    records.push({ frameId: engine.frameId, target, cameraRevision: current.revision, uniformRevision: uniforms.revision });
    if (records.length > 600) records.splice(0, records.length - 600);
  }

  const quadData = new VertexData();
  quadData.positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
  quadData.indices = [0, 1, 2, 0, 2, 3];
  const triangleData = new VertexData();
  triangleData.positions = [-1, -1, 0, 3, -1, 0, -1, 3, 0];
  triangleData.indices = [0, 1, 2];

  const placeholder = available
    ? RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 0, 255]), 1, 1, scene, false, false)
    : null;

  /** Every orb material, overlays and probes included, so the shader variant follows the experiment. */
  const orbMaterials = new Set<ShaderMaterial>();
  function withLeanDefine(defines: string[], lean: boolean): string[] {
    const others = defines.filter(define => define !== LEAN_DEFINE);
    return lean ? [...others, LEAN_DEFINE] : others;
  }
  function orbMaterial(name: string, defines: string[], reveal: boolean): ShaderMaterial {
    const material = new ShaderMaterial(name, scene, { vertexSource: webGpu ? ORB_VERTEX : ORB_VERTEX_GLSL, fragmentSource: webGpu ? ORB_FRAGMENT : ORB_FRAGMENT_GLSL }, {
      attributes: ["position"],
      uniforms: webGpu ? [...ORB_UNIFORMS] : [...ORB_UNIFORMS, ...ORB_LEAN_UNIFORMS],
      samplers: ["panoramaCube", "panoramaEquirect"],
      defines: withLeanDefine([...backendDefines, ...defines], leanShaders()),
      shaderLanguage,
      needAlphaBlending: !defines.some(define => define.includes("OUTPUT_")),
    });
    material.onCompiled = onCompiled;
    material.onError = onError;
    material.backFaceCulling = false;
    if (reveal) {
      material.depthFunction = Constants.ALWAYS;
      material.disableDepthWrite = true;
    }
    orbMaterials.add(material);
    material.onDisposeObservable.addOnce(() => orbMaterials.delete(material));
    return material;
  }

  interface OrbInternal extends PanoramaOrb {
    state: OrbState;
    expansion: OrbExpansion | null;
    mesh: Mesh;
    revealMesh: Mesh;
    material: ShaderMaterial;
    revealMaterial: ShaderMaterial;
    /** The overlay's material for an equirectangular source, made when one is first drawn. */
    revealEquirectMaterial: ShaderMaterial | null;
    /** Draws the orb's preview, or `source` in its place. */
    applyUniforms(material: ShaderMaterial, uniforms: PanoramaCameraFrame, radius: number, opacity: number, source?: ImmersionSource | null): boolean;
    /** The radius drawn at `distance` in `frame`: the screen-size bounds, then the display scale. */
    drawnRadius(distance: number, frame: PanoramaCameraFrame): number;
  }

  function applyContent(material: ShaderMaterial, content: Mat3, prefix = "content"): void {
    content.forEach((row, index) => material.setVector3(`${prefix}${index}`, toVector(row) as never));
  }

  function addOrb(id: string, initial: OrbState): PanoramaOrb {
    if (!available) {
      // No GPU drawing; the scene list still shows the panorama.
      return { id, update() {}, setExpansion() {}, effectiveRadius: () => null, dispose() {} };
    }
    const mesh = new Mesh(`panorama-orb-${id}`, scene);
    quadData.applyToMesh(mesh);
    const revealMesh = new Mesh(`panorama-orb-reveal-${id}`, scene);
    quadData.applyToMesh(revealMesh);
    for (const each of [mesh, revealMesh]) {
      each.alwaysSelectAsActiveMesh = true;
      each.isPickable = false;
      each.doNotSyncBoundingInfo = true;
    }
    // Drawn with the terrain, so it is depth tested against it; the reveal draws later, over everything.
    revealMesh.renderingGroupId = 1;
    revealMesh.setEnabled(false);
    const material = orbMaterial(`panorama-orb-material-${id}`, [], false);
    const revealMaterial = orbMaterial(`panorama-orb-reveal-material-${id}`, [], true);
    mesh.material = material;
    revealMesh.material = revealMaterial;
    const outlineColor = new Color4();

    const orb: OrbInternal = {
      id,
      state: { ...initial },
      expansion: null,
      mesh,
      revealMesh,
      material,
      revealMaterial,
      revealEquirectMaterial: null,
      applyUniforms(target, uniforms, radius, opacity, source) {
        const marker = orb.state.marker;
        if (!marker) return false;
        const rel = sub(marker, uniforms.eye);
        const near = scene.activeCamera?.minZ ?? NEAR_PLANE_WITHOUT_CAMERA;
        const outline = orb.state.outline;
        const quad = orbQuad(rel, radius, uniforms, near, outline?.widthPx ?? 0);
        target.setMatrix("viewRotProj", uniforms.viewRotProj);
        target.setVector3("quadCenter", toVector(quad.center) as never);
        target.setVector3("quadU", toVector(quad.u) as never);
        target.setVector3("quadV", toVector(quad.v) as never);
        target.setVector3("markerRel", toVector(rel) as never);
        target.setFloat("radius", radius);
        const tanPreviewHalfAngle = Math.tan((appearance.previewFovDeg * Math.PI) / 360);
        target.setFloat("tanPreviewHalfAngle", tanPreviewHalfAngle);
        if (leanShaders()) {
          const constants = orbDrawConstants(rel, radius, tanPreviewHalfAngle);
          target.setFloat("sinAlpha", constants.sinAlpha);
          target.setFloat("windowGain", constants.windowGain);
          target.setFloat("identityWindow", constants.identityWindow ? 1 : 0);
        }
        target.setFloat("opacity", opacity);
        // The shader measures the outline in the pixels it draws.
        const devicePerCss = engine.getRenderHeight() / Math.max(1, uniforms.viewportHeightCssPx);
        const [r, g, b, a] = outline?.color ?? [0, 0, 0, 0];
        target.setColor4("outlineColor", outlineColor.set(r, g, b, a));
        target.setFloat("outlineWidth", (outline?.widthPx ?? 0) * devicePerCss);
        applyContent(target, source?.content ?? orb.state.content);
        if (source?.kind === "equirectangular") target.setTexture("panoramaEquirect", source.texture);
        else target.setTexture("panoramaCube", source?.texture ?? orb.state.texture ?? placeholder!);
        return true;
      },
      update(state) {
        Object.assign(orb.state, state);
        const drawable = orb.state.visible && orb.state.marker !== null && orb.state.texture !== null;
        mesh.setEnabled(drawable);
        options.requestRender();
      },
      setExpansion(expansion) {
        orb.expansion = expansion;
        if (expansion?.source?.kind === "equirectangular") {
          orb.revealEquirectMaterial ??= orbMaterial(`panorama-orb-reveal-equirect-material-${id}`, ["#define SOURCE_EQUIRECT"], true);
          revealMesh.material = orb.revealEquirectMaterial;
        } else revealMesh.material = revealMaterial;
        revealMesh.setEnabled(expansion !== null && orb.state.marker !== null && (expansion.source?.texture ?? orb.state.texture) !== null);
        options.requestRender();
      },
      drawnRadius(distance, frame) {
        return effectiveOrbRadius(orb.state.radiusMeters, distance, frame, appearance.markerDiameterCssPx) * orb.state.displayScale;
      },
      effectiveRadius(frame) {
        const f = frame ?? drawFrame()?.current ?? null;
        if (!f || !orb.state.marker) return null;
        return orb.drawnRadius(length(sub(orb.state.marker, f.eye)), f);
      },
      dispose() {
        orbs.delete(id);
        mesh.onBeforeRenderObservable.remove(observer);
        revealMesh.onBeforeRenderObservable.remove(revealObserver);
        mesh.dispose();
        revealMesh.dispose();
        material.dispose();
        revealMaterial.dispose();
        orb.revealEquirectMaterial?.dispose();
        options.requestRender();
      },
    };
    const observer: Observer<Mesh> | null = mesh.onBeforeRenderObservable.add(timed(() => {
      const frames = drawFrame();
      if (!frames) return;
      // Expanding, the orb is the sphere itself, clipped by terrain where its overlay has not yet revealed it.
      const radius = orb.expansion?.radiusMeters ?? orb.drawnRadius(length(sub(orb.state.marker ?? frames.uniforms.eye, frames.uniforms.eye)), frames.uniforms);
      if (orb.applyUniforms(material, frames.uniforms, radius, 1)) record(`orb:${id}`, frames.current, frames.uniforms);
    }));
    const revealObserver: Observer<Mesh> | null = revealMesh.onBeforeRenderObservable.add(timed(() => {
      const frames = drawFrame();
      if (!frames || !orb.expansion) return;
      const target = orb.expansion.source?.kind === "equirectangular" ? orb.revealEquirectMaterial! : revealMaterial;
      if (orb.applyUniforms(target, frames.uniforms, orb.expansion.radiusMeters, orb.expansion.reveal, orb.expansion.source)) record(`reveal:${id}`, frames.current, frames.uniforms);
    }));
    orbs.set(id, orb);
    orb.update({});
    return orb;
  }

  // ─── Immersion ──────────────────────────────────────────────────────
  const immersionMesh = available ? new Mesh("panorama-immersion", scene) : null;
  const immersionMaterials = new Map<string, ShaderMaterial>();
  let immersionState: { source: ImmersionSource; next: ImmersionSource | null; mix: number; opacity: number; view: NavigationPresentation | null } | null = null;
  /** `opaque`: drawn without blending, for immersion at full opacity (the opaqueImmersion experiment). */
  function immersionMaterial(defines: string[], opaque = false): ShaderMaterial {
    const all = withLeanDefine(defines, leanShaders());
    const key = all.join(" ") + (opaque ? " opaque" : "");
    let material = immersionMaterials.get(key);
    if (!material) {
      material = new ShaderMaterial(`panorama-immersion-${key || "cube"}`, scene, { vertexSource: webGpu ? IMMERSION_VERTEX : IMMERSION_VERTEX_GLSL, fragmentSource: webGpu ? IMMERSION_FRAGMENT : IMMERSION_FRAGMENT_GLSL }, {
        attributes: ["position"],
        uniforms: webGpu ? [...IMMERSION_UNIFORMS] : [...IMMERSION_UNIFORMS, ...IMMERSION_LEAN_UNIFORMS],
        samplers: ["panoramaCube", "panoramaEquirect", "nextCube", "nextEquirect"],
        defines: [...backendDefines, ...all],
        shaderLanguage,
        needAlphaBlending: !opaque && !defines.some(define => define.includes("OUTPUT_")),
      });
      material.onCompiled = onCompiled;
      material.onError = onError;
      material.backFaceCulling = false;
      material.depthFunction = Constants.ALWAYS;
      material.disableDepthWrite = true;
      immersionMaterials.set(key, material);
    }
    return material;
  }
  function immersionDefines(state: { source: ImmersionSource; next: ImmersionSource | null }, output?: "direction" | "ray"): string[] {
    const defines: string[] = [];
    if (state.source.kind === "equirectangular") defines.push("#define SOURCE_EQUIRECT");
    if (state.next) defines.push(state.next.kind === "equirectangular" ? "#define NEXT_EQUIRECT" : "#define NEXT_CUBE");
    if (output) defines.push(output === "direction" ? "#define OUTPUT_DIRECTION" : "#define OUTPUT_RAY");
    return defines;
  }
  function applyImmersionUniforms(material: ShaderMaterial, uniforms: PanoramaCameraFrame): void {
    const state = immersionState;
    if (!state) return;
    material.setMatrix("inverseViewRotProj", uniforms.inverseViewRotProj);
    material.setFloat("opacity", state.opacity);
    material.setFloat("mixWeight", state.mix);
    applyContent(material, state.source.content);
    applyContent(material, (state.next ?? state.source).content, "nextContent");
    if (leanShaders()) {
      material.setMatrix("imageFromClip", imageFromClipMatrix(uniforms.inverseViewRotProj, state.source.content, new Matrix()));
      material.setMatrix("nextImageFromClip", imageFromClipMatrix(uniforms.inverseViewRotProj, (state.next ?? state.source).content, new Matrix()));
    }
    material.setTexture(state.source.kind === "equirectangular" ? "panoramaEquirect" : "panoramaCube", state.source.texture);
    if (state.next) material.setTexture(state.next.kind === "equirectangular" ? "nextEquirect" : "nextCube", state.next.texture);
  }
  if (immersionMesh) {
    triangleData.applyToMesh(immersionMesh);
    immersionMesh.alwaysSelectAsActiveMesh = true;
    immersionMesh.isPickable = false;
    immersionMesh.doNotSyncBoundingInfo = true;
    immersionMesh.renderingGroupId = 2;
    // Drawn by the globe camera normally and while it shows only the presentation layer.
    immersionMesh.layerMask = 0x0fffffff | NAVIGATION_PRESENTATION_LAYER;
    immersionMesh.setEnabled(false);
    immersionMesh.onBeforeRenderObservable.add(timed(() => {
      if (!immersionState) return;
      const material = immersionMesh.material as ShaderMaterial | null;
      if (!material) return;
      const override = immersionState.view ? currentFrame(immersionState.view) : null;
      const frames = override ? { current: override, uniforms: override } : drawFrame();
      if (!frames) return;
      applyImmersionUniforms(material, frames.uniforms);
      record("immersion", frames.current, frames.uniforms);
    }));
  }
  /** The immersion's material for its state and the experiments now. */
  function applyImmersionMaterial(): void {
    if (!immersionMesh || !immersionState) return;
    // The crossfade blends inside the shader; only a fade from the globe needs the frame behind.
    const opaque = experiments.opaqueImmersion && immersionState.opacity >= 1;
    immersionMesh.material = immersionMaterial(immersionDefines(immersionState), opaque);
  }
  const immersion: PanoramaImmersion = {
    show(state) {
      if (!immersionMesh) return;
      immersionState = state ? { source: state.source, next: state.next ?? null, mix: state.mix ?? 0, opacity: state.opacity ?? 1, view: state.view ?? null } : null;
      applyImmersionMaterial();
      immersionMesh.setEnabled(immersionState !== null);
      options.requestRender();
    },
    get visible() { return immersionState !== null; },
  };

  // ─── Picking and projection ─────────────────────────────────────────
  function rayThrough(frame: PanoramaCameraFrame, clientX: number, clientY: number): Vec3 | null {
    const canvas = engine.getRenderingCanvas();
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / Math.max(1, rect.width);
    const y = (clientY - rect.top) / Math.max(1, rect.height);
    const tanHalf = Math.tan(frame.view.verticalFovRad / 2);
    return normalize(add(frame.view.forward, add(scale(frame.view.right, (2 * x - 1) * tanHalf * frame.view.aspect), scale(frame.view.up, (1 - 2 * y) * tanHalf))));
  }

  function pick(clientX: number, clientY: number, isOccluded: (eye: Vec3, direction: Vec3, distance: number) => boolean): OrbHit[] {
    const frame = currentFrame();
    if (!frame) return [];
    const ray = rayThrough(frame, clientX, clientY);
    if (!ray) return [];
    const tanHalf = Math.tan(frame.view.verticalFovRad / 2);
    const hitHalfAngle = Math.atan(((appearance.hitTargetDiameterCssPx / 2) * 2 * tanHalf) / Math.max(1, frame.viewportHeightCssPx));
    const hits: OrbHit[] = [];
    for (const orb of orbs.values()) {
      const marker = orb.state.marker;
      if (!marker || !orb.state.visible || !orb.state.texture) continue;
      const rel = sub(marker, frame.eye);
      const d = length(rel);
      const radius = orb.drawnRadius(d, frame);
      if (d <= radius) continue;
      const axis = scale(rel, 1 / d);
      const angle = Math.acos(Math.max(-1, Math.min(1, dot(axis, ray))));
      // The outline is part of what is drawn, so part of what a click selects.
      const outlineAngle = Math.atan(((orb.state.outline?.widthPx ?? 0) * 2 * tanHalf) / Math.max(1, frame.viewportHeightCssPx));
      const onSilhouette = angle <= Math.asin(radius / d) + outlineAngle;
      if (!onSilhouette && angle > hitHalfAngle) continue;
      const depth = d - radius;
      if (isOccluded(frame.eye, axis, depth)) continue;
      hits.push({ id: orb.id, depthMeters: depth, onSilhouette });
    }
    return hits.sort((a, b) => Number(b.onSilhouette) - Number(a.onSilhouette) || a.depthMeters - b.depthMeters || (a.id < b.id ? -1 : 1));
  }

  function project(direction: Vec3, frame = currentFrame() ?? undefined): { x: number; y: number } | null {
    if (!frame) return null;
    const canvas = engine.getRenderingCanvas();
    if (!canvas) return null;
    const z = dot(direction, frame.view.forward);
    if (z <= 1e-6) return null;
    const tanHalf = Math.tan(frame.view.verticalFovRad / 2);
    const x = dot(direction, frame.view.right) / (z * tanHalf * frame.view.aspect);
    const y = dot(direction, frame.view.up) / (z * tanHalf);
    if (Math.abs(x) > 1.2 || Math.abs(y) > 1.2) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + ((x + 1) / 2) * rect.width, y: rect.top + ((1 - y) / 2) * rect.height };
  }

  // ─── Probe (tests) ──────────────────────────────────────────────────
  async function probe(target: { orb: string } | { immersion: true }, outputs: readonly PanoramaProbeOutput[]): Promise<PanoramaProbeResult> {
    if (!available) throw new Error(unavailableReason ?? "unavailable");
    if (outputs.length === 0) throw new Error("Ask for at least one output.");
    const width = engine.getRenderWidth();
    const height = engine.getRenderHeight();
    const orb = "orb" in target ? orbs.get(target.orb) : null;
    if ("orb" in target && !orb) throw new Error(`No orb ${target.orb}`);
    if (!("orb" in target) && !immersionState) throw new Error("Immersion is not shown.");
    let captured: PanoramaCameraFrame | null = null;
    const passes = outputs.map(output => {
      const rtt = new RenderTargetTexture(`panorama-probe-${output}`, { width, height }, scene, false, true, Constants.TEXTURETYPE_FLOAT);
      // Unset, a render target clears to the scene's colour; the probe needs coverage 0 where nothing drew.
      rtt.clearColor = new Color4(0, 0, 0, 0);
      const mesh = new Mesh(`panorama-probe-mesh-${output}`, scene);
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.isPickable = false;
      mesh.doNotSyncBoundingInfo = true;
      mesh.layerMask = 0;
      const define = output === "direction" ? "#define OUTPUT_DIRECTION" : "#define OUTPUT_RAY";
      let material: ShaderMaterial;
      let observer: Observer<Mesh> | null;
      if (orb) {
        quadData.applyToMesh(mesh);
        material = orbMaterial(`panorama-probe-orb-${output}`, [define], false);
        observer = mesh.onBeforeRenderObservable.add(() => {
          const frames = drawFrame();
          if (!frames) return;
          captured = frames.current;
          const radius = orb.expansion?.radiusMeters ?? effectiveOrbRadius(orb.state.radiusMeters, length(sub(orb.state.marker ?? frames.uniforms.eye, frames.uniforms.eye)), frames.uniforms, appearance.markerDiameterCssPx);
          orb.applyUniforms(material, frames.uniforms, radius, 1);
        });
      } else {
        triangleData.applyToMesh(mesh);
        material = immersionMaterial(immersionDefines(immersionState!, output));
        observer = mesh.onBeforeRenderObservable.add(() => {
          const override = immersionState?.view ? currentFrame(immersionState.view) : null;
          const frames = override ? { current: override, uniforms: override } : drawFrame();
          if (!frames) return;
          captured = frames.current;
          applyImmersionUniforms(material, frames.uniforms);
        });
      }
      mesh.material = material;
      rtt.renderList = [mesh];
      rtt.activeCamera = scene.activeCamera;
      rtt.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
      return { output, rtt, mesh, material, observer, ownsMaterial: Boolean(orb) };
    });
    try {
      // A render target renders once and skips a mesh whose shader is not ready,
      // as a WebGL shader compiling in parallel is not on its first frames.
      await Promise.all(passes.map(pass => pass.material.forceCompilationAsync(pass.mesh)));
      for (const pass of passes) scene.customRenderTargets.push(pass.rtt);
      // Every pass renders in the same frame, so every output shares one camera.
      const rendered = Promise.all(passes.map(pass => new Promise<void>(resolve => { pass.rtt.onAfterRenderObservable.addOnce(() => resolve()); })));
      options.requestRender();
      await rendered;
      const results: Partial<Record<PanoramaProbeOutput, Float32Array>> = {};
      for (const pass of passes) {
        const pixels = await pass.rtt.readPixels(0, 0, null, true, false);
        if (!pixels) throw new Error("The probe read nothing back.");
        results[pass.output] = new Float32Array((pixels as Float32Array).buffer.slice(0));
      }
      if (!captured) throw new Error("The probe drew nothing.");
      return { width, height, outputs: results, frame: captured };
    } finally {
      for (const pass of passes) {
        const index = scene.customRenderTargets.indexOf(pass.rtt);
        if (index >= 0) scene.customRenderTargets.splice(index, 1);
        pass.mesh.onBeforeRenderObservable.remove(pass.observer);
        pass.mesh.dispose();
        if (pass.ownsMaterial) pass.material.dispose();
        pass.rtt.dispose();
      }
    }
  }

  return {
    available,
    unavailableReason,
    addOrb,
    immersion,
    setAppearance(next) {
      appearance = next;
      options.requestRender();
    },
    cameraFrame: view => (view ? currentFrame(view) : drawFrame()?.current ?? currentFrame()),
    pick,
    project,
    probe,
    setExperiments(next) {
      const wasLean = leanShaders();
      Object.assign(experiments, next);
      if (leanShaders() !== wasLean) {
        // One compile for all orbs: materials with the same defines share an effect.
        for (const material of orbMaterials) material.options.defines = withLeanDefine(material.options.defines, leanShaders());
      }
      applyImmersionMaterial();
      frameCache = null;
      options.requestRender();
    },
    setUniformDelayFrames(frames) {
      delayFrames = Math.max(0, Math.min(7, Math.round(frames)));
    },
    captureDraws(capture) {
      captureDraws = capture;
    },
    drawRecords: () => records,
    inspectOrb(id, frame) {
      const orb = orbs.get(id);
      if (!orb) return null;
      const { marker, radiusMeters, content, visible, texture } = orb.state;
      return { marker, radiusMeters, effectiveRadius: orb.effectiveRadius(frame), content, visible, textured: texture !== null };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const orb of [...orbs.values()]) orb.dispose();
      immersionMesh?.dispose();
      for (const material of immersionMaterials.values()) material.dispose();
      immersionMaterials.clear();
      placeholder?.dispose();
    },
  };
}
