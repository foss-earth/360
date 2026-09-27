/**
 * Draws panorama orbs over the globe and the immersive view
 * (docs/proposals/panorama-scenes.md §3): each orb is a quad whose
 * fragments cast the camera's own rays at a sphere, with depth where the ray
 * meets it, so terrain in front hides it; immersion is one triangle covering
 * the view. Every frame's uniforms are computed from the camera as it is for
 * that frame, in float64 on the CPU, immediately before the mesh draws.
 *
 * WebGPU only: on another backend `createPanoramaRenderer` reports why and
 * draws nothing.
 */
import {
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
import { NAVIGATION_PRESENTATION_LAYER, type NavigationPresentation } from "../navigationLease";
import {
  IMMERSION_FRAGMENT,
  IMMERSION_UNIFORMS,
  IMMERSION_VERTEX,
  ORB_FRAGMENT,
  ORB_UNIFORMS,
  ORB_VERTEX,
} from "./panoramaShaders";
import { isWebGpuEngine } from "./panoramaTextures";

/** One frame's camera, as the globe is drawn with it: eye in float64 ECEF and the rotation-and-projection matrix. */
export interface PanoramaCameraFrame {
  eye: Vec3;
  viewRotProj: Matrix;
  inverseViewRotProj: Matrix;
  view: ViewBasis;
  viewportHeightCssPx: number;
  /** A digest of the camera state, to correlate a frame's draws with its camera. */
  revision: string;
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
}

export interface OrbExpansion {
  /** The virtual radius the overlay draws with, metres. */
  radiusMeters: number;
  /** 0: clipped by terrain like the orb; 1: drawn over everything. */
  reveal: number;
}

export interface PanoramaOrb {
  readonly id: string;
  update(state: Partial<OrbState>): void;
  /** Draws the expanding entry overlay, or stops it with null. */
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

export interface PanoramaProbeResult {
  width: number;
  height: number;
  /** RGBA float32 rows as read back. */
  data: Float32Array;
  frame: PanoramaCameraFrame;
}

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
  /** Test only: renders what `target` shows as float directions and reads it back. */
  probe(target: { orb: string } | { immersion: true }, output: "direction" | "ray"): Promise<PanoramaProbeResult>;
  /** Test only: draw with uniforms this many frames old (the negative control). */
  setUniformDelayFrames(frames: number): void;
  /** Test only: the last frames' camera and uniform revisions, to show no draw used a stale camera. */
  drawRecords(): readonly { frameId: number; target: string; cameraRevision: string; uniformRevision: string }[];
  dispose(): void;
}

// ─── Pure geometry ─────────────────────────────────────────────────────

/** The quad an orb draws: perpendicular to the axis, or across the view when the sphere is near or around the eye. */
export function orbQuad(rel: Vec3, radius: number, frame: Pick<PanoramaCameraFrame, "view" | "viewportHeightCssPx">, nearPlane: number): { center: Vec3; u: Vec3; v: Vec3; fullscreen: boolean } {
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
  const half = d * Math.tan(alpha) + 3 * pixel;
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
}

export function createPanoramaRenderer(scene: Scene, options: PanoramaRendererOptions): PanoramaRenderer {
  const engine = scene.getEngine();
  const available = isWebGpuEngine(engine);
  const unavailableReason = available ? null : "Panoramas are drawn with WebGPU, and this page is using WebGL. The scene list still works; entering is off.";
  let appearance: OrbAppearance = { previewFovDeg: 90, markerDiameterCssPx: { min: 24, max: 96 }, hitTargetDiameterCssPx: 44 };
  let delayFrames = 0;
  const records: { frameId: number; target: string; cameraRevision: string; uniformRevision: string }[] = [];
  const orbs = new Map<string, OrbInternal>();
  let disposed = false;

  function canvasCssHeight(): number {
    const canvas = engine.getRenderingCanvas();
    return canvas?.clientHeight || engine.getRenderHeight() || 1;
  }

  /** The camera the globe is drawn with this frame, or the presentation that replaces its view. */
  function currentFrame(presentation = options.getPresentationView()): PanoramaCameraFrame | null {
    const camera: Camera | null = scene.activeCamera;
    if (!camera) return null;
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
      const view = camera.getViewMatrix();
      rotation = rotationOnly(view);
      basis = basisFromViewMatrix(view);
      verticalFovRad = camera.fov;
      projection = camera.getProjectionMatrix();
    }
    const viewRotProj = rotation.multiply(projection);
    const inverseViewRotProj = viewRotProj.clone().invert();
    const revision = [...eye, ...basis.forward, ...basis.up, verticalFovRad, aspect].map(value => value.toPrecision(12)).join(",");
    return {
      eye,
      viewRotProj,
      inverseViewRotProj,
      view: { ...basis, verticalFovRad, aspect },
      viewportHeightCssPx: canvasCssHeight(),
      revision,
    };
  }

  // The frame used by every draw this rendered frame, and, for the negative
  // control, the ones before it.
  let frameCache: { id: number; frame: PanoramaCameraFrame | null } | null = null;
  const history: PanoramaCameraFrame[] = [];
  function drawFrame(): { current: PanoramaCameraFrame; uniforms: PanoramaCameraFrame } | null {
    const id = engine.frameId;
    if (!frameCache || frameCache.id !== id) {
      const frame = currentFrame();
      frameCache = { id, frame };
      if (frame) {
        history.unshift(frame);
        history.length = Math.min(history.length, 8);
      }
    }
    const current = frameCache.frame;
    if (!current) return null;
    const uniforms = history[Math.min(delayFrames, history.length - 1)] ?? current;
    return { current, uniforms };
  }

  function record(target: string, current: PanoramaCameraFrame, uniforms: PanoramaCameraFrame): void {
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

  function orbMaterial(name: string, defines: string[], reveal: boolean): ShaderMaterial {
    const material = new ShaderMaterial(name, scene, { vertexSource: ORB_VERTEX, fragmentSource: ORB_FRAGMENT }, {
      attributes: ["position"],
      uniforms: [...ORB_UNIFORMS],
      samplers: ["panoramaCube"],
      defines,
      shaderLanguage: ShaderLanguage.WGSL,
      needAlphaBlending: !defines.length,
    });
    material.backFaceCulling = false;
    if (reveal) {
      material.depthFunction = Constants.ALWAYS;
      material.disableDepthWrite = true;
    }
    return material;
  }

  interface OrbInternal extends PanoramaOrb {
    state: OrbState;
    expansion: OrbExpansion | null;
    mesh: Mesh;
    revealMesh: Mesh;
    material: ShaderMaterial;
    revealMaterial: ShaderMaterial;
    applyUniforms(material: ShaderMaterial, uniforms: PanoramaCameraFrame, radius: number, opacity: number): boolean;
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

    const orb: OrbInternal = {
      id,
      state: { ...initial },
      expansion: null,
      mesh,
      revealMesh,
      material,
      revealMaterial,
      applyUniforms(target, uniforms, radius, opacity) {
        const marker = orb.state.marker;
        if (!marker) return false;
        const rel = sub(marker, uniforms.eye);
        const near = scene.activeCamera?.minZ ?? NEAR_PLANE_WITHOUT_CAMERA;
        const quad = orbQuad(rel, radius, uniforms, near);
        target.setMatrix("viewRotProj", uniforms.viewRotProj);
        target.setVector3("quadCenter", toVector(quad.center) as never);
        target.setVector3("quadU", toVector(quad.u) as never);
        target.setVector3("quadV", toVector(quad.v) as never);
        target.setVector3("markerRel", toVector(rel) as never);
        target.setFloat("radius", radius);
        target.setFloat("tanPreviewHalfAngle", Math.tan((appearance.previewFovDeg * Math.PI) / 360));
        target.setFloat("opacity", opacity);
        applyContent(target, orb.state.content);
        target.setTexture("panoramaCube", orb.state.texture ?? placeholder!);
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
        revealMesh.setEnabled(expansion !== null && orb.state.marker !== null && orb.state.texture !== null);
        options.requestRender();
      },
      effectiveRadius(frame) {
        const f = frame ?? drawFrame()?.current ?? null;
        if (!f || !orb.state.marker) return null;
        return effectiveOrbRadius(orb.state.radiusMeters, length(sub(orb.state.marker, f.eye)), f, appearance.markerDiameterCssPx);
      },
      dispose() {
        orbs.delete(id);
        mesh.onBeforeRenderObservable.remove(observer);
        revealMesh.onBeforeRenderObservable.remove(revealObserver);
        mesh.dispose();
        revealMesh.dispose();
        material.dispose();
        revealMaterial.dispose();
        options.requestRender();
      },
    };
    const observer: Observer<Mesh> | null = mesh.onBeforeRenderObservable.add(() => {
      const frames = drawFrame();
      if (!frames) return;
      const radius = effectiveOrbRadius(orb.state.radiusMeters, length(sub(orb.state.marker ?? frames.uniforms.eye, frames.uniforms.eye)), frames.uniforms, appearance.markerDiameterCssPx);
      if (orb.applyUniforms(material, frames.uniforms, radius, 1)) record(`orb:${id}`, frames.current, frames.uniforms);
    });
    const revealObserver: Observer<Mesh> | null = revealMesh.onBeforeRenderObservable.add(() => {
      const frames = drawFrame();
      if (!frames || !orb.expansion) return;
      if (orb.applyUniforms(revealMaterial, frames.uniforms, orb.expansion.radiusMeters, orb.expansion.reveal)) record(`reveal:${id}`, frames.current, frames.uniforms);
    });
    orbs.set(id, orb);
    orb.update({});
    return orb;
  }

  // ─── Immersion ──────────────────────────────────────────────────────
  const immersionMesh = available ? new Mesh("panorama-immersion", scene) : null;
  const immersionMaterials = new Map<string, ShaderMaterial>();
  let immersionState: { source: ImmersionSource; next: ImmersionSource | null; mix: number; opacity: number; view: NavigationPresentation | null } | null = null;
  function immersionMaterial(defines: string[]): ShaderMaterial {
    const key = defines.join(" ");
    let material = immersionMaterials.get(key);
    if (!material) {
      material = new ShaderMaterial(`panorama-immersion-${key || "cube"}`, scene, { vertexSource: IMMERSION_VERTEX, fragmentSource: IMMERSION_FRAGMENT }, {
        attributes: ["position"],
        uniforms: [...IMMERSION_UNIFORMS],
        samplers: ["panoramaCube", "panoramaEquirect", "nextCube", "nextEquirect"],
        defines,
        shaderLanguage: ShaderLanguage.WGSL,
        needAlphaBlending: !defines.some(define => define.includes("OUTPUT_")),
      });
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
    immersionMesh.onBeforeRenderObservable.add(() => {
      if (!immersionState) return;
      const material = immersionMesh.material as ShaderMaterial | null;
      if (!material) return;
      const override = immersionState.view ? currentFrame(immersionState.view) : null;
      const frames = override ? { current: override, uniforms: override } : drawFrame();
      if (!frames) return;
      applyImmersionUniforms(material, frames.uniforms);
      record("immersion", frames.current, frames.uniforms);
    });
  }
  const immersion: PanoramaImmersion = {
    show(state) {
      if (!immersionMesh) return;
      immersionState = state ? { source: state.source, next: state.next ?? null, mix: state.mix ?? 0, opacity: state.opacity ?? 1, view: state.view ?? null } : null;
      if (immersionState) immersionMesh.material = immersionMaterial(immersionDefines(immersionState));
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
      const radius = effectiveOrbRadius(orb.state.radiusMeters, d, frame, appearance.markerDiameterCssPx);
      if (d <= radius) continue;
      const axis = scale(rel, 1 / d);
      const angle = Math.acos(Math.max(-1, Math.min(1, dot(axis, ray))));
      const alpha = Math.asin(radius / d);
      const onSilhouette = angle <= alpha;
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
  async function probe(target: { orb: string } | { immersion: true }, output: "direction" | "ray"): Promise<PanoramaProbeResult> {
    if (!available) throw new Error(unavailableReason ?? "unavailable");
    const width = engine.getRenderWidth();
    const height = engine.getRenderHeight();
    const rtt = new RenderTargetTexture("panorama-probe", { width, height }, scene, false, true, Constants.TEXTURETYPE_FLOAT);
    rtt.clearColor.set(0, 0, 0, 0);
    const probeMesh = new Mesh("panorama-probe-mesh", scene);
    probeMesh.alwaysSelectAsActiveMesh = true;
    probeMesh.isPickable = false;
    probeMesh.doNotSyncBoundingInfo = true;
    probeMesh.layerMask = 0;
    let material: ShaderMaterial;
    let observer: Observer<Mesh> | null;
    let captured: PanoramaCameraFrame | null = null;
    if ("orb" in target) {
      const orb = orbs.get(target.orb);
      if (!orb) throw new Error(`No orb ${target.orb}`);
      quadData.applyToMesh(probeMesh);
      material = orbMaterial("panorama-probe-orb", [output === "direction" ? "#define OUTPUT_DIRECTION" : "#define OUTPUT_RAY"], false);
      observer = probeMesh.onBeforeRenderObservable.add(() => {
        const frames = drawFrame();
        if (!frames) return;
        captured = frames.current;
        const radius = orb.expansion?.radiusMeters ?? effectiveOrbRadius(orb.state.radiusMeters, length(sub(orb.state.marker ?? frames.uniforms.eye, frames.uniforms.eye)), frames.uniforms, appearance.markerDiameterCssPx);
        orb.applyUniforms(material, frames.uniforms, radius, 1);
      });
    } else {
      if (!immersionState) throw new Error("Immersion is not shown.");
      triangleData.applyToMesh(probeMesh);
      material = immersionMaterial(immersionDefines(immersionState, output));
      observer = probeMesh.onBeforeRenderObservable.add(() => {
        const override = immersionState?.view ? currentFrame(immersionState.view) : null;
        const frames = override ? { current: override, uniforms: override } : drawFrame();
        if (!frames) return;
        captured = frames.current;
        applyImmersionUniforms(material, frames.uniforms);
      });
    }
    probeMesh.material = material;
    rtt.renderList = [probeMesh];
    rtt.activeCamera = scene.activeCamera;
    rtt.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    scene.customRenderTargets.push(rtt);
    try {
      await new Promise<void>(resolve => {
        rtt.onAfterRenderObservable.addOnce(() => resolve());
        options.requestRender();
      });
      const pixels = await rtt.readPixels(0, 0, null, true, false);
      if (!pixels || !captured) throw new Error("The probe read nothing back.");
      return { width, height, data: new Float32Array((pixels as Float32Array).buffer.slice(0)), frame: captured };
    } finally {
      const index = scene.customRenderTargets.indexOf(rtt);
      if (index >= 0) scene.customRenderTargets.splice(index, 1);
      probeMesh.onBeforeRenderObservable.remove(observer);
      probeMesh.dispose();
      if ("orb" in target) material.dispose();
      rtt.dispose();
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
    setUniformDelayFrames(frames) {
      delayFrames = Math.max(0, Math.min(7, Math.round(frames)));
    },
    drawRecords: () => records,
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
