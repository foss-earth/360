/**
 * A loaded scene and everything it owns (docs/proposals/panorama-scenes.md
 * §5): its orbs, their placements and previews, the navigation lease while a
 * panorama is entered, look input, history entries and every request,
 * decode, upload and texture. `dispose` releases all of it, once.
 *
 *   overview → preparing → entering → immersive → exiting → overview
 *                 ↓           ↓
 *               cancel → prior usable view
 *   immersive → preparing destination → entering destination → immersive
 */
import type { Scene } from "@babylonjs/core";
import type { ActionIntentFrame } from "@felipegalind0/gamepad-tools/core";
import type { BabylonRuntime } from "../engine/babylon/createBabylonRuntime";
import type { FrameProfiler } from "../perf/frameProfiler";
import type { NavigationLease, NavigationPresentation } from "../engine/babylon/navigationLease";
import { createPanoramaRenderer, type ImmersionSource, type PanoramaOrb, type PanoramaRenderer } from "../engine/babylon/panorama/panoramaRenderer";
import { createPanoramaUploader, isWebGpuEngine, type PanoramaGpuTexture, type PanoramaUploader } from "../engine/babylon/panorama/panoramaTextures";
import { getAppSettings } from "../settings/appSettings";
import type { SettingsRegistry } from "../settings/registry";
import { isNumberRange } from "../settings/values";
import { SCENE_PARAMETERS } from "../settings/catalogue/scenes";
import { chooseRepresentation, MIB, representationFaceTexels } from "./budget";
import type { AttributionRecord, ResolvedAsset, ResolvedPanorama, ResolvedRepresentation, SceneDiagnostic, ValidatedScene, ViewRecord } from "./format";
import { attachLookInput, createLookModel, type LookModel, type LookSettings, type LookState } from "./panoramaInput";
import {
  captureRelativeMarker,
  contentMatrix,
  DEG_TO_RAD,
  enuFrame,
  expansionTargetRadius,
  groundQueryPoint,
  groundRelativeMarker,
  handoffReady,
  immersionFaceTexels,
  length,
  orbGeometry,
  previewFaceTexels,
  scale,
  sub,
  type EnuFrame,
  type Mat3,
  type Vec3,
} from "./panoramaMath";
import { createPanoramaResources, resourceSettingsFrom, ResourceRefusal, type ResourceBackend, type SourceHandle } from "./panoramaResources";
import { createBrowserSceneHistory, type SceneHistoryAdapter, type SceneHistoryEntry } from "./sceneHistory";
import { interpolateView, presentationFromView, snapshotFromOverview, viewFromPresentation, type GeoView } from "./sceneView";
import { validateScene, type SceneLimits } from "./validateScene";

/**
 * The scene's frame budget sections. Its per-frame work runs in the scene's
 * before-render step, inside profileBabylonScene's "render"; decode wall time
 * is background work, alongside frames rather than in one.
 */
const FRAME_SECTION = "render/scenes";
const UPLOAD_SECTION = "render/scenes/upload";
const PLACEMENT_SECTION = "render/scenes/placement";
const DECODE_COMPLETION_SECTION = "scenes/decode completion";
const DECODE_WALL_SECTION = "background/panorama decode";

// ─── Public types ──────────────────────────────────────────────────────

/** What a scene needs from the runtime: the public `foss-earth/runtime` surface. */
export type SceneRuntime = Pick<BabylonRuntime,
  | "surface" | "acquireNavigation" | "captureNavigationSnapshot" | "restoreNavigationSnapshot"
  | "getPresentationView" | "setNavigationIntentHandler" | "requestRender" | "beginContinuous" | "endContinuous"
  | "onDeviceLost" | "onDeviceRestored" | "prepareTerrain"> & {
    scene?: Scene;
    /** Where the scene's own frame work is timed, when the runtime profiles. */
    frameProfile?: { profiler: FrameProfiler };
  };

export type ScenePhase = "overview" | "preparing" | "entering" | "immersive" | "exiting" | "disposed";

export interface SceneEntryStatus {
  id: string;
  title: string;
  description: string | null;
  supported: boolean;
  /** Why it cannot be shown, when unsupported or failed. */
  message: string | null;
  placement: "pending" | "placed" | "unavailable";
  preview: "idle" | "loading" | "ready" | "failed";
  /** The preview's size, and what kept it smaller than asked, if anything. */
  previewDetail: { representation: string; faceTexels: number; limitation: string | null } | null;
  marker: { mode: "ground-relative" | "capture-relative"; eastM: number; northM: number; offsetM: number; radiusMeters: number; authoredRadius: boolean };
  capture: { longitudeDeg: number; latitudeDeg: number; heightMeters: number | null };
  links: { id: string; label: string; target: string; enabled: boolean; placed: boolean }[];
}

export interface SceneStatus {
  phase: ScenePhase;
  sceneId: string;
  revision: string;
  title: string;
  generation: number;
  /** The panorama on screen, while immersive. */
  active: string | null;
  /** The panorama being prepared or entered. */
  target: string | null;
  entries: SceneEntryStatus[];
  groups: { id: string; title: string; members: string[] }[];
  /** Credits for what is on screen now. */
  credits: (AttributionRecord & { assetId: string })[];
  immersionDetail: { representation: string; limitation: string | null } | null;
  overview: "none" | "pending" | "applied";
  renderingAvailable: boolean;
  unavailableReason: string | null;
  warnings: readonly SceneDiagnostic[];
  lastError: string | null;
  view: LookState | null;
}

export type SceneActionResult =
  | { ok: true }
  | { ok: false; reason: "disposed" | "busy" | "cancelled" | "unavailable" | "failed"; message: string };

export interface EnterOptions {
  signal?: AbortSignal;
  /** An arrival view that overrides the entry policy for this arrival. */
  view?: ViewRecord;
}

export interface SceneHandle {
  readonly status: SceneStatus;
  enter(id: string, options?: EnterOptions): Promise<SceneActionResult>;
  follow(linkId: string, options?: { signal?: AbortSignal }): Promise<SceneActionResult>;
  exit(): Promise<SceneActionResult>;
  /** Validates `input` first; on failure the current scene stays. */
  replace(input: SceneInput, options?: { baseUrl?: string | URL; signal?: AbortSignal }): Promise<{ ok: true } | { ok: false; errors: readonly SceneDiagnostic[] }>;
  /** Moves the globe to the scene's overview, loading the map there first when needed. */
  showOverview(options?: { signal?: AbortSignal }): Promise<SceneActionResult>;
  /** Link buttons of the entered panorama, placed on the canvas this frame. */
  hotspots(): { id: string; label: string; x: number; y: number }[];
  /** Orbs under a canvas point, nearest first; enter the first to select it. */
  pick(clientX: number, clientY: number): string[];
  subscribe(listener: (status: SceneStatus) => void): () => void;
  /** Called after each drawn frame while something on screen moves, for DOM overlays. */
  onFrame(listener: () => void): () => void;
  dispose(): void;
  readonly disposed: boolean;
}

export type SceneInput = string | URL | Record<string, unknown>;

export interface LoadSceneOptions {
  /** What relative URLs in programmatic JSON resolve against. A fetched manifest uses its final URL. */
  baseUrl?: string | URL;
  signal?: AbortSignal;
  settings?: SettingsRegistry;
  /** Moves the globe to the manifest's overview once its ground is displayed. Default true. */
  applyOverview?: boolean;
  /** Browser history, the default, or another adapter; null keeps navigation in memory. */
  history?: SceneHistoryAdapter | null;
  /** Test seams: a renderer, a GPU backend and a frame driver. */
  internals?: {
    renderer?: SceneRenderer;
    backend?: ResourceBackend<PanoramaGpuTexture>;
    onFrame?: (callback: () => void) => () => void;
    now?: () => number;
    reducedMotion?: () => boolean;
    /** Test only: receives the renderer this scene creates, for probes and the negative control. */
    onRenderer?: (renderer: PanoramaRenderer) => void;
  };
}

export type SceneRenderer = Pick<PanoramaRenderer, "available" | "unavailableReason" | "addOrb" | "immersion" | "setAppearance" | "cameraFrame" | "pick" | "project" | "dispose">;

export type LoadSceneResult =
  | { ok: true; handle: SceneHandle }
  | { ok: false; errors: readonly SceneDiagnostic[] };

// ─── Manifest input ────────────────────────────────────────────────────

/** A host's own registry gets the scene parameters it lacks, so every value has its one definition. */
function ensureSceneParameters(settings: SettingsRegistry): void {
  const missing = SCENE_PARAMETERS.filter(spec => !settings.has(spec.id));
  if (missing.length > 0) settings.register(missing);
}

function sceneLimits(settings: SettingsRegistry): SceneLimits {
  ensureSceneParameters(settings);
  return {
    manifestBytes: Math.round(settings.get<number>("scene.manifestMiB") * MIB),
    entities: Math.round(settings.get<number>("scene.entityLimit")),
    assets: Math.round(settings.get<number>("scene.assetLimit")),
    links: Math.round(settings.get<number>("scene.linkLimit")),
  };
}

/** Reads a manifest within the byte limit, following redirects; its final URL is the base. */
async function fetchManifest(url: URL, maxBytes: number, signal?: AbortSignal): Promise<{ text: string; baseUrl: string } | { error: string }> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "omit", signal });
  } catch (error) {
    return { error: `${url.href} could not be fetched: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response.ok) return { error: `${url.href} answered ${response.status}` };
  const reader = response.body?.getReader();
  if (!reader) return { error: `${url.href} has no body` };
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      void reader.cancel();
      return { error: `the manifest passed the ${maxBytes}-byte limit (scene.manifestMiB) while arriving` };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return { text: new TextDecoder().decode(bytes), baseUrl: response.url || url.href };
}

async function resolveInput(input: SceneInput, settings: SettingsRegistry, baseUrl: string | URL | undefined, signal?: AbortSignal): Promise<{ ok: true; scene: ValidatedScene } | { ok: false; errors: readonly SceneDiagnostic[] }> {
  const limits = sceneLimits(settings);
  const isUrl = input instanceof URL || (typeof input === "string" && !input.trim().startsWith("{"));
  if (isUrl) {
    let url: URL;
    try {
      url = new URL(String(input), baseUrl ?? (typeof document !== "undefined" ? document.baseURI : undefined));
    } catch {
      return { ok: false, errors: [{ path: "$", message: `${String(input)} is not a URL` }] };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, errors: [{ path: "$", message: "a scene URL must be http or https" }] };
    const fetched = await fetchManifest(url, limits.manifestBytes, signal);
    if ("error" in fetched) return { ok: false, errors: [{ path: "$", message: fetched.error }] };
    const result = validateScene(fetched.text, { baseUrl: fetched.baseUrl, limits });
    return result.ok ? { ok: true, scene: result.scene } : { ok: false, errors: result.errors };
  }
  const result = validateScene(input, { baseUrl: baseUrl ?? null, limits });
  return result.ok ? { ok: true, scene: result.scene } : { ok: false, errors: result.errors };
}

/**
 * Validates a scene and mounts it: orbs appear as their ground and previews
 * are ready, and the overview is applied once its ground is displayed.
 * Nothing is fetched beyond the manifest before validation passes.
 */
export async function loadScene(runtime: SceneRuntime, input: SceneInput, options: LoadSceneOptions = {}): Promise<LoadSceneResult> {
  const settings = options.settings ?? getAppSettings();
  const resolved = await resolveInput(input, settings, options.baseUrl, options.signal);
  if (!resolved.ok) return resolved;
  if (options.signal?.aborted) return { ok: false, errors: [{ path: "$", message: "Loading was cancelled." }] };
  return { ok: true, handle: createSceneHandle(runtime, resolved.scene, settings, options) };
}

// ─── The handle ────────────────────────────────────────────────────────

interface Placement {
  state: "pending" | "placed" | "unavailable";
  marker: Vec3 | null;
  revision: number | null;
  frozen: boolean;
  message: string | null;
}

interface Preview {
  state: "idle" | "loading" | "ready" | "failed";
  handle: SourceHandle<PanoramaGpuTexture> | null;
  limitation: string | null;
  message: string | null;
  controller: AbortController | null;
}

interface Entry {
  record: ResolvedPanorama;
  asset: ResolvedAsset;
  frame: EnuFrame;
  content: Mat3;
  orb: PanoramaOrb;
  placement: Placement;
  preview: Preview;
}

interface Immersion {
  lease: NavigationLease;
  id: string;
  shown: { handle: SourceHandle<PanoramaGpuTexture>; entry: Entry };
  detail: { representation: string; limitation: string | null };
  refine: AbortController | null;
  look: LookModel;
  roll: number;
  input: { applyIntents(frame: ActionIntentFrame): void; detach(): void };
  offIntents: () => void;
  offLeaseAbort: () => void;
  session: string;
}

let sessionCounter = 0;

function createSceneHandle(runtime: SceneRuntime, initialScene: ValidatedScene, settings: SettingsRegistry, options: LoadSceneOptions): SceneHandle {
  const scene = runtime.scene;
  const engine = scene?.getEngine() ?? null;
  const canvas = engine?.getRenderingCanvas() ?? null;
  const now = options.internals?.now ?? (() => performance.now());
  const profiler = runtime.frameProfile?.profiler ?? null;
  const timedCall = <T>(section: string, work: () => T): T => {
    const started = profiler?.clock() ?? 0;
    const result = work();
    if (started) profiler!.add(section, started);
    return result;
  };
  const listeners = new Set<(status: SceneStatus) => void>();
  const frameListeners = new Set<() => void>();
  const cleanups: (() => void)[] = [];
  let current = initialScene;
  let generation = 1;
  let phase: ScenePhase = "overview";
  let target: string | null = null;
  let lastError: string | null = null;
  let overviewState: SceneStatus["overview"] = current.overview && options.applyOverview !== false ? "pending" : "none";
  let appliedOverviewFov = false;
  let entries = new Map<string, Entry>();
  let immersion: Immersion | null = null;
  let operation: AbortController | null = null;
  let disposed = false;
  const session = `${Date.now().toString(36)}-${++sessionCounter}`;
  const history = options.history === undefined ? (typeof window !== "undefined" ? createBrowserSceneHistory() : null) : options.history;
  let historyStarted = false;

  const num = (id: string): number => settings.get<number>(id);
  const range = (id: string): { min: number; max: number } => {
    const value = settings.get(id);
    if (!isNumberRange(value)) throw new Error(`${id} is not a range`);
    return value;
  };
  const reducedMotion = options.internals?.reducedMotion ?? (() => settings.get("scene.panorama.reducedMotion") === "reduce"
    || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches));
  const previewHalfAngle = () => (num("scene.panorama.previewFov") * DEG_TO_RAD) / 2;
  const devicePixelsPerCss = () => (engine ? 1 / engine.getHardwareScalingLevel() : 1);
  const lookSettings = (): LookSettings => ({
    dragSensitivity: num("scene.panorama.dragSensitivity"),
    lookRate: num("scene.panorama.lookRate"),
    zoomPerNotch: num("scene.panorama.zoomPerNotch"),
    zoomRate: num("scene.panorama.zoomRate"),
    pinchGain: num("scene.panorama.pinchGain"),
    inertiaHalfLifeMs: num("scene.panorama.inertiaHalfLife"),
    fovRangeDeg: range("scene.panorama.verticalFovRange"),
    pitchRangeDeg: range("scene.panorama.pitchRange"),
    reducedMotion: reducedMotion(),
  });

  // ─── GPU side ───────────────────────────────────────────────────────
  const renderer: SceneRenderer = options.internals?.renderer ?? (() => {
    const created = createPanoramaRenderer(scene!, {
      getPresentationView: () => runtime.getPresentationView(),
      requestRender: () => runtime.requestRender(),
      ...(profiler ? { profiler } : {}),
    });
    options.internals?.onRenderer?.(created);
    return created;
  })();
  const applyAppearance = (): void => renderer.setAppearance({
    previewFovDeg: num("scene.panorama.previewFov"),
    markerDiameterCssPx: range("scene.panorama.markerDiameter"),
    hitTargetDiameterCssPx: num("scene.panorama.hitTargetDiameter"),
  });
  applyAppearance();
  // The device's limit, when there is a device; otherwise only the parameters limit sizes.
  const deviceMaxSide = (): number => engine?.getCaps().maxTextureSize ?? settings.getDeviceContext().maxTextureSize ?? Number.POSITIVE_INFINITY;
  let uploader: PanoramaUploader | null = null;
  const uploadLimits = () => ({ bytesPerFrame: num("scene.panorama.uploadMiBPerFrame") * MIB, outstandingBytes: num("scene.panorama.uploadOutstandingMiB") * MIB });
  const backend: ResourceBackend<PanoramaGpuTexture> = options.internals?.backend ?? (() => {
    const gpuUploader = scene && isWebGpuEngine(engine) ? createPanoramaUploader(scene, uploadLimits(), () => runtime.requestRender()) : null;
    uploader = gpuUploader;
    const refuse = () => Promise.reject(new ResourceRefusal(renderer.unavailableReason ?? "Panoramas need WebGPU.", "device"));
    return {
      fetch: (url, init) => fetch(url, init),
      // The browser decodes off the main thread: its wall time runs alongside frames, not in one.
      async decode(bytes) {
        const started = profiler?.clock() ?? 0;
        const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { colorSpaceConversion: "none", premultiplyAlpha: "none", imageOrientation: "from-image" });
        if (started) profiler!.add(DECODE_WALL_SECTION, started);
        return bitmap;
      },
      // Allocating the texture and queueing its rows: what finishing a decode costs the frame.
      uploadCube: (faces, label) => (gpuUploader ? timedCall(DECODE_COMPLETION_SECTION, () => gpuUploader.uploadCube(faces, label)) : refuse()),
      uploadEquirect: (image, label) => (gpuUploader ? timedCall(DECODE_COMPLETION_SECTION, () => gpuUploader.uploadEquirect(image, label)) : refuse()),
      maxTextureSide: deviceMaxSide,
    };
  })();
  const resources = createPanoramaResources(backend, resourceSettingsFrom(id => settings.get(id), deviceMaxSide()));

  // One frame driver: scene frames in the app, a test's ticker otherwise.
  const frameCallbacks = new Set<() => void>();
  const onFrame = options.internals?.onFrame ?? ((callback: () => void) => {
    const observer = scene!.onBeforeRenderObservable.add(callback);
    return () => { scene!.onBeforeRenderObservable.remove(observer); };
  });
  const offFrame = onFrame(() => {
    const started = profiler?.clock() ?? 0;
    timedCall(UPLOAD_SECTION, () => uploader?.pump());
    for (const callback of [...frameCallbacks]) callback();
    timedCall(PLACEMENT_SECTION, () => { refreshPlacements(); tryApplyOverview(); });
    for (const listener of [...frameListeners]) listener();
    if (started) profiler!.add(FRAME_SECTION, started);
  });
  cleanups.push(offFrame);

  // ─── Status ─────────────────────────────────────────────────────────
  let notifyQueued = false;
  // Internal waiters hear every change at once; subscribers once per microtask.
  const internalListeners = new Set<() => void>();
  function subscribeInternal(listener: () => void): () => void {
    internalListeners.add(listener);
    return () => { internalListeners.delete(listener); };
  }
  function emit(): void {
    for (const listener of [...internalListeners]) listener();
    if (notifyQueued || (disposed && listeners.size === 0)) return;
    notifyQueued = true;
    queueMicrotask(() => {
      notifyQueued = false;
      const status = buildStatus();
      for (const listener of [...listeners]) listener(status);
    });
  }

  function buildStatus(): SceneStatus {
    const list: SceneEntryStatus[] = current.entityOrder.map(id => {
      const entry = entries.get(id);
      const unsupported = current.unsupported.get(id);
      if (!entry) {
        return {
          id, title: id, description: null, supported: false, message: unsupported?.reason ?? "Not shown by this loader.",
          placement: "unavailable", preview: "failed", previewDetail: null,
          marker: { mode: "ground-relative", eastM: 0, northM: 0, offsetM: 0, radiusMeters: 0, authoredRadius: false },
          capture: { longitudeDeg: 0, latitudeDeg: 0, heightMeters: null }, links: [],
        };
      }
      const { record } = entry;
      const representation = entry.preview.handle?.representation ?? null;
      return {
        id,
        title: record.title,
        description: record.description ?? null,
        supported: true,
        message: entry.preview.message ?? entry.placement.message,
        placement: entry.placement.state,
        preview: entry.preview.state,
        previewDetail: representation ? { representation: representation.id, faceTexels: representationFaceTexels(representation), limitation: entry.preview.limitation } : null,
        marker: { ...record.marker, radiusMeters: record.marker.radiusMeters ?? num("scene.panorama.markerRadiusMeters"), authoredRadius: record.marker.radiusMeters !== undefined },
        capture: { longitudeDeg: record.capture.longitudeDeg, latitudeDeg: record.capture.latitudeDeg, heightMeters: record.capture.height?.meters ?? null },
        links: record.links.map(link => ({
          id: link.id, label: link.label, target: link.target,
          enabled: entries.has(link.target), placed: Boolean(link.direction),
        })),
      };
    });
    const visibleAssets = new Set<string>();
    if (immersion) visibleAssets.add(immersion.shown.entry.asset.id);
    else for (const entry of entries.values()) if (entry.placement.state === "placed" && entry.preview.state === "ready") visibleAssets.add(entry.asset.id);
    return {
      phase,
      sceneId: current.id,
      revision: current.revision,
      title: current.title,
      generation,
      active: immersion?.id ?? null,
      target,
      entries: list,
      groups: current.groups.map(group => ({ id: group.id, title: group.title, members: [...group.members] })),
      credits: [...visibleAssets].map(assetId => ({ assetId, ...current.assets.get(assetId)!.attribution })),
      immersionDetail: immersion?.detail ?? null,
      overview: overviewState,
      renderingAvailable: renderer.available,
      unavailableReason: renderer.unavailableReason,
      warnings: current.warnings,
      lastError,
      view: immersion ? immersion.look.get() : null,
    };
  }

  // ─── Mounting ───────────────────────────────────────────────────────
  function mount(validated: ValidatedScene): void {
    for (const record of validated.panoramas.values()) {
      const asset = validated.assets.get(record.assetId)!;
      const frame = enuFrame(record.capture.longitudeDeg, record.capture.latitudeDeg);
      const content = contentMatrix(frame, record.imagePose);
      const orb = renderer.addOrb(record.id, {
        marker: null,
        radiusMeters: record.marker.radiusMeters ?? num("scene.panorama.markerRadiusMeters"),
        content,
        texture: null,
        visible: true,
      });
      const entry: Entry = {
        record, asset, frame, content, orb,
        placement: { state: "pending", marker: null, revision: null, frozen: false, message: null },
        preview: { state: "idle", handle: null, limitation: null, message: null, controller: null },
      };
      entries.set(record.id, entry);
      if (record.marker.mode === "capture-relative" && record.capture.height) {
        const marker = captureRelativeMarker(record.capture, record.capture.height.meters, record.marker.eastM, record.marker.northM, record.marker.offsetM);
        entry.placement = { state: "placed", marker, revision: null, frozen: false, message: null };
        orb.update({ marker });
      }
      if (renderer.available) loadPreview(entry, 1);
      else entry.preview.message = renderer.unavailableReason;
    }
    refreshPlacements();
    emit();
  }

  function unmount(): void {
    for (const entry of entries.values()) {
      entry.preview.controller?.abort();
      entry.preview.handle?.release();
      entry.orb.dispose();
    }
    entries = new Map();
  }

  /** The preview that meets the orb's largest on-screen size at the asked density, within its range and the budget. */
  function choosePreview(entry: Entry): { representation: ResolvedRepresentation; limitation: string | null } | null {
    const diameter = range("scene.panorama.markerDiameter").max * devicePixelsPerCss();
    const wanted = previewFaceTexels(diameter, previewHalfAngle(), num("scene.panorama.previewDensity"));
    const faces = range("scene.panorama.previewFaceRange");
    const previews = entry.asset.representations.filter(rep => rep.role === "preview" && rep.projection === "cube");
    const inRange = previews.filter(rep => rep.projection === "cube" && rep.faceSize >= faces.min && rep.faceSize <= faces.max);
    const pool = inRange.length > 0 ? inRange : previews;
    const choice = chooseRepresentation(pool, "preview", Math.min(Math.max(wanted, faces.min), faces.max), rep => (resources.wouldFit(rep) ? null : "the panorama GPU memory is full (scene.panorama.sourceGpuMiB)"));
    if (!choice) return null;
    const outOfRange = inRange.length === 0 ? `no preview is within ${faces.min}–${faces.max} px (scene.panorama.previewFaceRange)` : null;
    return { representation: choice.representation, limitation: [outOfRange, choice.limitation].filter(Boolean).join("; ") || null };
  }

  function loadPreview(entry: Entry, priority: number): void {
    if (entry.preview.state === "loading" || entry.preview.state === "ready") return;
    const choice = choosePreview(entry);
    if (!choice) {
      entry.preview = { ...entry.preview, state: "failed", message: "No preview fits the panorama GPU memory (scene.panorama.sourceGpuMiB)." };
      emit();
      return;
    }
    const controller = new AbortController();
    const loadingGeneration = generation;
    entry.preview = { state: "loading", handle: null, limitation: choice.limitation, message: null, controller };
    emit();
    resources.acquire(entry.asset, choice.representation, { signal: controller.signal, priority }).then(handle => {
      // A late arrival for a replaced or disposed scene is released, never shown.
      if (disposed || loadingGeneration !== generation || entries.get(entry.record.id) !== entry || controller.signal.aborted) {
        handle.release();
        return;
      }
      entry.preview = { state: "ready", handle, limitation: choice.limitation, message: null, controller: null };
      entry.orb.update({ texture: handle.texture.texture });
      runtime.requestRender();
      emit();
    }, error => {
      if (disposed || loadingGeneration !== generation || controller.signal.aborted) return;
      entry.preview = { state: "failed", handle: null, limitation: null, message: error instanceof Error ? error.message : String(error), controller: null };
      emit();
    });
  }

  /** Ground-relative markers follow the displayed surface until an entry freezes them. */
  function refreshPlacements(): void {
    const revision = runtime.surface.revision?.() ?? null;
    let changed = false;
    for (const entry of entries.values()) {
      const { record, placement } = entry;
      if (record.marker.mode !== "ground-relative" || placement.frozen) continue;
      if (placement.state === "placed" && revision !== null && placement.revision === revision) continue;
      const query = groundQueryPoint(record.capture, record.marker.eastM, record.marker.northM);
      const hit = runtime.surface.sample(query.latitudeDeg, query.longitudeDeg);
      if (!hit) continue;
      const marker = groundRelativeMarker(query, hit.heightMeters, record.marker.offsetM);
      const moved = !placement.marker || length(sub(marker, placement.marker)) > 1e-3;
      entry.placement = { state: "placed", marker, revision: revision ?? hit.revision, frozen: false, message: null };
      if (moved) { entry.orb.update({ marker }); changed = true; }
    }
    if (changed) { runtime.requestRender(); emit(); }
  }

  function tryApplyOverview(): void {
    if (overviewState !== "pending" || !current.overview || phase !== "overview") return;
    const { target: place } = current.overview;
    let ground = 0;
    if (!place.height) {
      const hit = runtime.surface.sample(place.latitudeDeg, place.longitudeDeg);
      if (!hit) return;
      ground = hit.heightMeters;
    }
    if (runtime.restoreNavigationSnapshot(snapshotFromOverview(current.overview, ground))) {
      overviewState = "applied";
      appliedOverviewFov = true;
      emit();
    }
  }

  // ─── Animation ──────────────────────────────────────────────────────
  /** Runs `step(t)` for t from 0 to 1 over `durationMs`, one step per frame, holding rendering meanwhile. */
  function animate(durationMs: number, step: (t: number) => void, signal: AbortSignal, lease: NavigationLease | null): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (!(durationMs > 0)) { step(1); return Promise.resolve(); }
    const release = lease ? lease.holdRendering() : (runtime.beginContinuous(), () => runtime.endContinuous());
    const started = now();
    return new Promise<void>((resolve, reject) => {
      const tick = (): void => {
        if (signal.aborted) { finish(); reject(signal.reason); return; }
        const t = Math.min(1, (now() - started) / durationMs);
        step(t);
        if (t >= 1) { finish(); resolve(); }
      };
      const finish = (): void => {
        frameCallbacks.delete(tick);
        signal.removeEventListener("abort", onAbort);
        release();
      };
      const onAbort = (): void => { finish(); reject(signal.reason); };
      signal.addEventListener("abort", onAbort, { once: true });
      frameCallbacks.add(tick);
      runtime.requestRender();
    });
  }
  const smooth = (t: number) => t * t * (3 - 2 * t);

  // ─── Views ──────────────────────────────────────────────────────────
  function geoView(look: LookState, roll: number): GeoView {
    return { headingDeg: look.headingDeg, pitchDeg: look.pitchDeg, rollDeg: roll, verticalFovDeg: look.verticalFovDeg };
  }
  function presentation(entry: Entry, view: GeoView): NavigationPresentation {
    return presentationFromView(entry.frame, entry.placement.marker ?? scale(entry.frame.up, 0), view);
  }
  function arrivalFor(entry: Entry, incoming: GeoView, explicit: ViewRecord | undefined): GeoView {
    const settingsNow = lookSettings();
    const clampFov = (fov: number) => Math.min(settingsNow.fovRangeDeg.max, Math.max(settingsNow.fovRangeDeg.min, fov));
    const authored = explicit ?? (settings.get("scene.panorama.entryOrientation") === "authored" ? entry.record.initialView : undefined);
    if (authored) return { headingDeg: authored.headingDeg, pitchDeg: authored.pitchDeg, rollDeg: 0, verticalFovDeg: clampFov(authored.verticalFovDeg) };
    return { headingDeg: incoming.headingDeg, pitchDeg: 0, rollDeg: 0, verticalFovDeg: clampFov(incoming.verticalFovDeg) };
  }

  function recordHistory(mode: "push" | "replace"): void {
    if (!history) return;
    const entry: SceneHistoryEntry = {
      v: 1, session, sceneId: current.id, revision: current.revision,
      destination: immersion?.id ?? null, view: immersion ? immersion.look.get() : null,
    };
    history.record(entry, mode);
  }

  // ─── Transitions ────────────────────────────────────────────────────
  function beginOperation(signal?: AbortSignal): AbortController {
    operation?.abort(new DOMException("Replaced by another navigation.", "AbortError"));
    const controller = new AbortController();
    operation = controller;
    signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    return controller;
  }

  async function ensurePreview(entry: Entry, signal: AbortSignal): Promise<SourceHandle<PanoramaGpuTexture>> {
    if (entry.preview.state !== "ready") {
      entry.preview.controller?.abort();
      entry.preview = { ...entry.preview, state: "idle", controller: null };
      loadPreview(entry, 10);
    }
    while (entry.preview.state === "loading") {
      await new Promise<void>((resolve, reject) => {
        const unsubscribe = subscribeInternal(() => { if (entry.preview.state !== "loading") { unsubscribe(); resolve(); } });
        signal.addEventListener("abort", () => { unsubscribe(); reject(signal.reason); }, { once: true });
      });
    }
    if (entry.preview.state !== "ready" || !entry.preview.handle) throw new Error(entry.preview.message ?? `${entry.record.title} has no preview.`);
    return entry.preview.handle;
  }

  function failure(error: unknown, signal: AbortSignal): SceneActionResult {
    if (disposed) return { ok: false, reason: "disposed", message: "The scene has been disposed." };
    if (signal.aborted) return { ok: false, reason: "cancelled", message: "Cancelled." };
    const message = error instanceof Error ? error.message : String(error);
    lastError = message;
    return { ok: false, reason: "failed", message };
  }

  function sourceOf(entry: Entry, handle: SourceHandle<PanoramaGpuTexture>): ImmersionSource {
    return { texture: handle.texture.texture, kind: handle.texture.kind, content: entry.content };
  }

  /** Starts immersion in `entry` with `view`: look input, controller intents and lease loss handling. */
  function startImmersion(lease: NavigationLease, entry: Entry, handle: SourceHandle<PanoramaGpuTexture>, view: GeoView, detail: Immersion["detail"]): Immersion {
    // The callbacks below run once the state exists.
    const self: { state: Immersion | null } = { state: null };
    const look = createLookModel({ headingDeg: view.headingDeg, pitchDeg: view.pitchDeg, verticalFovDeg: view.verticalFovDeg }, lookSettings, next => {
      const state = self.state;
      if (!state || immersion !== state) return;
      lease.setPresentationView(presentation(state.shown.entry, geoView(next, state.roll)));
      scheduleLookHistory();
      emit();
    });
    // The handoff view is kept exactly: the look model's clamps apply from the first user look.
    const input = canvas
      ? attachLookInput({
        canvas, model: look,
        onExit: () => { void handle_.exit(); },
        onUserInput: () => cancelArrival(),
        requestFrame: () => runtime.requestRender(),
      })
      : { applyIntents() {}, detach() {} };
    const offIntents = runtime.setNavigationIntentHandler(lease, frame => input.applyIntents(frame));
    const onLeaseAbort = (): void => {
      // The runtime ended the lease (device loss or teardown): leave immersion in place of the owner.
      if (self.state && immersion === self.state) teardownImmersion("lease");
    };
    lease.signal.addEventListener("abort", onLeaseAbort, { once: true });
    const state: Immersion = {
      lease, id: entry.record.id, shown: { handle, entry }, detail, refine: null, look, roll: view.rollDeg, input, offIntents,
      offLeaseAbort: () => lease.signal.removeEventListener("abort", onLeaseAbort), session,
    };
    self.state = state;
    return state;
  }

  let arrival: AbortController | null = null;
  function cancelArrival(): void {
    arrival?.abort(new DOMException("Looking cancels levelling.", "AbortError"));
    arrival = null;
  }

  /** Until immersion starts, Escape, a press or a wheel on the canvas cancel the entry. */
  function cancelOnInput(op: AbortController): () => void {
    const cancel = (): void => op.abort(new DOMException("Cancelled by input.", "AbortError"));
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") { event.preventDefault(); cancel(); } };
    window.addEventListener("keydown", onKey);
    canvas?.addEventListener("pointerdown", cancel);
    canvas?.addEventListener("wheel", cancel, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      canvas?.removeEventListener("pointerdown", cancel);
      canvas?.removeEventListener("wheel", cancel);
    };
  }

  let lookHistoryTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleLookHistory(): void {
    if (!history || !historyStarted) return;
    if (lookHistoryTimer) clearTimeout(lookHistoryTimer);
    // After the gesture settles, not every frame.
    lookHistoryTimer = setTimeout(() => { lookHistoryTimer = null; if (immersion) recordHistory("replace"); }, 400);
  }

  /** Levels the view (or turns to an explicit arrival) after a handoff; user input cancels it. */
  async function arrive(state: Immersion, to: GeoView): Promise<void> {
    const from = geoView(state.look.get(), state.roll);
    arrival?.abort();
    const controller = new AbortController();
    arrival = controller;
    const duration = reducedMotion() ? 0 : num("scene.panorama.orientDuration");
    try {
      await animate(duration, t => {
        if (immersion !== state) return;
        const view = interpolateView(from, to, smooth(t));
        state.roll = view.rollDeg;
        state.look.set({ headingDeg: view.headingDeg, pitchDeg: view.pitchDeg, verticalFovDeg: view.verticalFovDeg });
      }, controller.signal, state.lease);
    } catch {
      // Cancelled by looking: keep the current view, level the roll only.
      if (immersion === state && state.roll !== 0) {
        state.roll = 0;
        state.look.set(state.look.get());
      }
    } finally {
      if (arrival === controller) arrival = null;
    }
  }

  /** Loads the immersion representation in the background and crossfades to it, or keeps the preview and says why. */
  function refine(state: Immersion): void {
    state.refine?.abort();
    const controller = new AbortController();
    state.refine = controller;
    const entry = state.shown.entry;
    const frame = renderer.cameraFrame(runtime.getPresentationView());
    // Without a frame to measure, ask for the largest that fits.
    const wanted = frame
      ? immersionFaceTexels(frame.viewportHeightCssPx * devicePixelsPerCss(), state.look.get().verticalFovDeg * DEG_TO_RAD, num("scene.panorama.immersionDensity"))
      : Number.POSITIVE_INFINITY;
    const maxSide = Math.min(deviceMaxSide(), num("scene.panorama.immersionMaxSide"));
    const candidates = entry.asset.representations.filter(rep => rep.role === "immersion" || rep.id === state.shown.handle.representation.id);
    const choice = chooseRepresentation(candidates, "any", wanted, rep => {
      if (rep.id === state.shown.handle.representation.id) return null;
      const side = rep.projection === "cube" ? rep.faceSize : rep.width;
      if (side > maxSide) return `${side} px is over the ${maxSide} px limit (scene.panorama.immersionMaxSide)`;
      return resources.wouldFit(rep, true) ? null : "it does not fit the panorama GPU memory or the replacement overlap (scene.panorama.sourceGpuMiB, overlapMiB)";
    });
    if (!choice || choice.representation.id === state.shown.handle.representation.id) {
      state.detail = { representation: state.shown.handle.representation.id, limitation: choice?.limitation ?? "no larger representation fits" };
      emit();
      return;
    }
    resources.acquire(entry.asset, choice.representation, { signal: controller.signal, priority: 5, overlap: true }).then(async handle => {
      if (immersion !== state || controller.signal.aborted || state.shown.entry !== entry) { handle.release(); return; }
      const previous = state.shown.handle;
      const fade = reducedMotion() ? num("scene.panorama.reducedFadeDuration") : num("scene.panorama.fadeDuration");
      try {
        await animate(fade, t => {
          if (immersion === state) renderer.immersion.show({ source: sourceOf(entry, previous), next: sourceOf(entry, handle), mix: smooth(t) });
        }, controller.signal, state.lease);
      } catch {
        handle.release();
        return;
      }
      if (immersion !== state) { handle.release(); return; }
      renderer.immersion.show({ source: sourceOf(entry, handle) });
      state.shown = { handle, entry };
      state.detail = { representation: handle.representation.id, limitation: choice.limitation };
      // The preview stays cached for the orb; only the reference is dropped.
      if (previous !== entry.preview.handle) previous.release();
      emit();
    }, error => {
      if (immersion !== state || controller.signal.aborted) return;
      state.detail = { representation: state.shown.handle.representation.id, limitation: error instanceof Error ? error.message : String(error) };
      emit();
    });
  }

  function teardownImmersion(reason: "exit" | "lease" | "dispose"): void {
    const state = immersion;
    if (!state) return;
    immersion = null;
    arrival?.abort();
    arrival = null;
    state.refine?.abort();
    state.input.detach();
    state.offIntents();
    state.offLeaseAbort();
    renderer.immersion.show(null);
    if (state.shown.handle !== state.shown.entry.preview.handle) state.shown.handle.release();
    for (const entry of entries.values()) entry.placement.frozen = false;
    if (reason === "lease") {
      // The lease is gone, so the globe camera is free: return to the overview it was entered from.
      runtime.restoreNavigationSnapshot(state.lease.overview);
      phase = "overview";
      target = null;
      lastError = "Navigation ended: the renderer lost its device or was torn down.";
    }
    emit();
  }

  async function enter(id: string, enterOptions: EnterOptions = {}): Promise<SceneActionResult> {
    if (disposed) return { ok: false, reason: "disposed", message: "The scene has been disposed." };
    const entry = entries.get(id);
    if (!entry) return { ok: false, reason: "unavailable", message: current.unsupported.get(id)?.reason ?? `No panorama ${id} in this scene.` };
    if (!renderer.available) return { ok: false, reason: "unavailable", message: renderer.unavailableReason ?? "Panoramas cannot be drawn here." };
    if (immersion) return navigateWithin(entry, enterOptions.view, enterOptions.signal, "push");
    const op = beginOperation(enterOptions.signal);
    const { signal } = op;
    phase = "preparing";
    target = id;
    lastError = null;
    emit();
    let lease: NavigationLease | null = null;
    const stopCancelling = typeof window !== "undefined" ? cancelOnInput(op) : () => {};
    try {
      const handle = await ensurePreview(entry, signal);
      if (signal.aborted) throw signal.reason;
      const acquired = runtime.acquireNavigation({ owner: "foss-earth.scenes", inputContext: "panorama", signal, terrain: "paused" });
      if (!acquired.ok) {
        phase = "overview";
        target = null;
        emit();
        return { ok: false, reason: acquired.reason === "aborted" ? "cancelled" : "busy", message: acquired.message };
      }
      lease = acquired.lease;
      phase = "entering";
      entry.placement.frozen = true;
      emit();
      const frame = renderer.cameraFrame();
      if (!frame) throw new Error("The globe camera is not ready.");
      let incoming = viewFromPresentation(entry.frame, {
        position: { x: frame.eye[0], y: frame.eye[1], z: frame.eye[2] },
        forward: { x: frame.view.forward[0], y: frame.view.forward[1], z: frame.view.forward[2] },
        up: { x: frame.view.up[0], y: frame.view.up[1], z: frame.view.up[2] },
        verticalFovRad: frame.view.verticalFovRad,
      });
      const source = sourceOf(entry, handle);
      const marker = entry.placement.marker;
      const betaR = previewHalfAngle();
      const expansion = marker && entry.placement.state === "placed" && !reducedMotion()
        ? (() => {
          const rel = sub(marker, frame.eye);
          const distance = length(rel);
          const startRadius = entry.orb.effectiveRadius(frame) ?? entry.record.marker.radiusMeters ?? 1;
          if (distance <= startRadius) return null;
          const radius = expansionTargetRadius(distance, scale(rel, 1 / distance), frame.view, betaR);
          return radius === null ? null : { rel, distance, startRadius, radius };
        })()
        : null;
      if (expansion) {
        // Grow a virtual sphere about the fixed marker until it covers the view and its rays equal the view's.
        await animate(num("scene.panorama.expandDuration"), t => {
          const eased = smooth(t);
          entry.orb.setExpansion({ radiusMeters: expansion.startRadius + (expansion.radius - expansion.startRadius) * eased, reveal: eased });
        }, signal, lease);
        if (!handoffReady(orbGeometry(expansion.rel, expansion.radius), frame.view, betaR)) throw new Error("The expanded orb did not cover the view; this is a defect.");
        // Handoff: identical rays, so the fullscreen image equals the orb's last frame.
        renderer.immersion.show({ source });
        lease.setPresentationView(presentation(entry, incoming));
        entry.orb.setExpansion(null);
      } else {
        // No continuous reveal from here (behind, inside, off screen or reduced motion): fade in the arrival view.
        const view = arrivalFor(entry, incoming, enterOptions.view);
        const target = presentation(entry, view);
        const fade = reducedMotion() ? num("scene.panorama.reducedFadeDuration") : num("scene.panorama.fadeDuration");
        await animate(fade, t => renderer.immersion.show({ source, opacity: smooth(t), view: target }), signal, lease);
        renderer.immersion.show({ source });
        lease.setPresentationView(target);
        incoming = view;
      }
      stopCancelling();
      const state = startImmersion(lease, entry, handle, incoming, { representation: handle.representation.id, limitation: entry.preview.limitation });
      immersion = state;
      phase = "immersive";
      target = null;
      if (history) {
        if (!historyStarted) { recordHistoryOverview(); historyStarted = true; }
        recordHistory("push");
      }
      emit();
      refine(state);
      void arrive(state, arrivalFor(entry, incoming, enterOptions.view));
      return { ok: true };
    } catch (error) {
      entry.orb.setExpansion(null);
      entry.placement.frozen = false;
      if (lease && !immersion) {
        renderer.immersion.show(null);
        runtime.restoreNavigationSnapshot(lease.overview, lease);
        lease.release("cancelled");
      }
      if (!immersion) { phase = "overview"; target = null; }
      const result = failure(error, signal);
      emit();
      return result;
    } finally {
      stopCancelling();
      if (operation === op) operation = null;
    }
  }

  function recordHistoryOverview(): void {
    history?.record({ v: 1, session, sceneId: current.id, revision: current.revision, destination: null, view: null }, "replace");
  }

  /** From one panorama to another: load its preview, crossfade, keep the geographic view (or the link's). */
  async function navigateWithin(entry: Entry, arrivalView: ViewRecord | undefined, external: AbortSignal | undefined, historyMode: "push" | "none"): Promise<SceneActionResult> {
    const state = immersion!;
    if (state.id === entry.record.id && !arrivalView) return { ok: true };
    const op = beginOperation(external);
    const { signal } = op;
    phase = "preparing";
    target = entry.record.id;
    emit();
    try {
      const handle = await ensurePreview(entry, signal);
      if (immersion !== state) throw new DOMException("Immersion ended.", "AbortError");
      phase = "entering";
      emit();
      const look = state.look.get();
      // Geographic heading, pitch and FOV carry over, expressed in the destination's own frame.
      const view: GeoView = arrivalView
        ? { headingDeg: arrivalView.headingDeg, pitchDeg: arrivalView.pitchDeg, rollDeg: 0, verticalFovDeg: arrivalView.verticalFovDeg }
        : { headingDeg: look.headingDeg, pitchDeg: look.pitchDeg, rollDeg: 0, verticalFovDeg: look.verticalFovDeg };
      const from = state.shown;
      const fade = reducedMotion() ? num("scene.panorama.reducedFadeDuration") : num("scene.panorama.fadeDuration");
      const fromView = presentation(from.entry, geoView(look, state.roll));
      const toView = presentation(entry, view);
      await animate(fade, t => {
        // Two different places: a crossfade of the images, each drawn in its own frame.
        renderer.immersion.show({ source: sourceOf(from.entry, from.handle), next: sourceOf(entry, handle), mix: smooth(t), view: t < 0.5 ? fromView : toView });
      }, signal, state.lease);
      if (immersion !== state) throw new DOMException("Immersion ended.", "AbortError");
      state.refine?.abort();
      if (from.handle !== from.entry.preview.handle) from.handle.release();
      state.shown = { handle, entry };
      state.id = entry.record.id;
      state.detail = { representation: handle.representation.id, limitation: entry.preview.limitation };
      entry.placement.frozen = true;
      state.roll = 0;
      renderer.immersion.show({ source: sourceOf(entry, handle) });
      state.look.set({ headingDeg: view.headingDeg, pitchDeg: view.pitchDeg, verticalFovDeg: view.verticalFovDeg });
      state.lease.setPresentationView(presentation(entry, view));
      phase = "immersive";
      target = null;
      if (historyMode === "push") recordHistory("push");
      emit();
      refine(state);
      return { ok: true };
    } catch (error) {
      if (immersion === state) {
        // The previous panorama stays usable.
        renderer.immersion.show({ source: sourceOf(state.shown.entry, state.shown.handle) });
        state.lease.setPresentationView(presentation(state.shown.entry, geoView(state.look.get(), state.roll)));
        phase = "immersive";
      }
      target = null;
      const result = failure(error, signal);
      emit();
      return result;
    } finally {
      if (operation === op) operation = null;
    }
  }

  async function follow(linkId: string, followOptions: { signal?: AbortSignal } = {}): Promise<SceneActionResult> {
    if (disposed) return { ok: false, reason: "disposed", message: "The scene has been disposed." };
    const state = immersion;
    if (!state) return { ok: false, reason: "unavailable", message: "Links are followed from inside a panorama." };
    const link = state.shown.entry.record.links.find(each => each.id === linkId);
    if (!link) return { ok: false, reason: "unavailable", message: `No link ${linkId} here.` };
    const destination = entries.get(link.target);
    if (!destination) return { ok: false, reason: "unavailable", message: `${link.label} leads to something this loader does not show.` };
    return navigateWithin(destination, link.arrivalView, followOptions.signal, "push");
  }

  async function exitTo(historyMode: "push" | "none"): Promise<SceneActionResult> {
    if (disposed) return { ok: false, reason: "disposed", message: "The scene has been disposed." };
    if (!immersion) {
      // Escape during preparation or entry cancels it.
      if (operation) { operation.abort(new DOMException("Cancelled.", "AbortError")); return { ok: true }; }
      return { ok: true };
    }
    const state = immersion;
    const op = beginOperation();
    phase = "exiting";
    emit();
    const view = presentation(state.shown.entry, geoView(state.look.get(), state.roll));
    const source = sourceOf(state.shown.entry, state.shown.handle);
    // Back to the saved overview first, then the image fades off it.
    runtime.restoreNavigationSnapshot(state.lease.overview, state.lease);
    state.lease.setPresentationView(null);
    const fade = reducedMotion() ? num("scene.panorama.reducedFadeDuration") : num("scene.panorama.fadeDuration");
    try {
      await animate(fade, t => renderer.immersion.show({ source, opacity: 1 - smooth(t), view }), op.signal, state.lease);
    } catch {
      // Exit completes regardless.
    }
    const focus = state.lease.focusReturn;
    teardownImmersion("exit");
    state.lease.release("exit");
    phase = "overview";
    target = null;
    if (historyMode === "push") recordHistory("push");
    if (focus instanceof HTMLElement && focus.isConnected) focus.focus();
    if (operation === op) operation = null;
    emit();
    return { ok: true };
  }

  // Back and Forward navigate without pushing again.
  if (history) {
    cleanups.push(history.subscribe(entry => {
      if (disposed) return;
      if (!entry || entry.session !== session || entry.sceneId !== current.id) {
        if (immersion) void exitTo("none");
        return;
      }
      if (entry.revision !== current.revision) {
        lastError = "That history entry belongs to another revision of this scene.";
        if (immersion) void exitTo("none");
        emit();
        return;
      }
      if (entry.destination === null) {
        if (immersion) void exitTo("none");
        return;
      }
      const destination = entries.get(entry.destination);
      if (!destination) { lastError = `${entry.destination} is no longer in this scene.`; emit(); return; }
      const view = entry.view ? { headingDeg: entry.view.headingDeg, pitchDeg: entry.view.pitchDeg, verticalFovDeg: entry.view.verticalFovDeg } : undefined;
      if (immersion) void navigateWithin(destination, view, undefined, "none");
      else void enter(destination.record.id, { view }).then(result => {
        // enter pushes on commit; a history-driven entry replaces instead.
        if (result.ok) recordHistory("replace");
      });
    }));
  }

  // ─── Device loss ────────────────────────────────────────────────────
  cleanups.push(runtime.onDeviceLost(() => {
    // The runtime already ended the lease; every GPU source is gone.
    uploader?.cancelAll("The GPU device was lost.");
    resources.invalidateDevice();
    for (const entry of entries.values()) {
      entry.preview.controller?.abort();
      entry.preview.handle?.release();
      entry.preview = { state: "idle", handle: null, limitation: null, message: "Waiting for the GPU to recover.", controller: null };
      entry.orb.update({ texture: null });
    }
    emit();
  }));
  cleanups.push(runtime.onDeviceRestored(() => {
    if (disposed) return;
    for (const entry of entries.values()) loadPreview(entry, 1);
  }));

  // ─── Settings ───────────────────────────────────────────────────────
  const loadingIds = ["sourceGpuMiB", "overlapMiB", "decodedMiB", "encodedMiB", "responseMiB", "requests", "decodes", "requestTimeout", "immersionMaxSide"].map(id => `scene.panorama.${id}`);
  for (const id of loadingIds) cleanups.push(settings.watch(id, () => resources.setSettings(resourceSettingsFrom(each => settings.get(each), deviceMaxSide()))));
  for (const id of ["scene.panorama.uploadMiBPerFrame", "scene.panorama.uploadOutstandingMiB"]) cleanups.push(settings.watch(id, () => uploader?.setLimits(uploadLimits())));
  for (const id of ["scene.panorama.previewFov", "scene.panorama.markerDiameter", "scene.panorama.hitTargetDiameter"]) cleanups.push(settings.watch(id, applyAppearance));
  cleanups.push(settings.watch("scene.panorama.markerRadiusMeters", () => {
    for (const entry of entries.values()) if (entry.record.marker.radiusMeters === undefined) entry.orb.update({ radiusMeters: num("scene.panorama.markerRadiusMeters") });
    emit();
  }));
  const mebibytes = (bytes: number) => `${(bytes / MIB).toFixed(bytes >= 10 * MIB ? 0 : 1)} MiB`;
  const readings: [string, () => string | null][] = [
    ["scene.panorama.sourceGpuMiB", () => { const p = resources.stats().pools.sourceGpu; return `${mebibytes(p.reserved)} reserved, ${mebibytes(p.peak)} at most so far`; }],
    ["scene.panorama.overlapMiB", () => `${mebibytes(resources.stats().pools.overlap.reserved)} of replacement coexisting`],
    ["scene.panorama.decodedMiB", () => `${mebibytes(resources.stats().pools.decoded.reserved)} decoded and waiting to upload`],
    ["scene.panorama.encodedMiB", () => `${mebibytes(resources.stats().pools.encoded.reserved)} downloaded or arriving`],
    ["scene.panorama.responseMiB", () => { const s = resources.stats(); return `largest so far ${mebibytes(s.largestResponseBytes)}${s.rejectedResponses ? `, ${s.rejectedResponses} refused` : ""}`; }],
    ["scene.panorama.requests", () => { const s = resources.stats(); return `${s.activeRequests} active, ${s.queuedRequests} queued`; }],
    ["scene.panorama.decodes", () => { const s = resources.stats(); return `${s.activeDecodes} active, ${s.queuedDecodes} queued`; }],
    ["scene.panorama.uploadMiBPerFrame", () => (uploader ? `${mebibytes(uploader.stats().lastFrameBytes)} in the last frame` : null)],
    ["scene.panorama.uploadOutstandingMiB", () => (uploader ? `${mebibytes(uploader.stats().outstandingBytes)} submitted, not yet done` : null)],
  ];
  for (const [id, read] of readings) cleanups.push(settings.setReadingSource(id, read));

  // ─── Public handle ──────────────────────────────────────────────────
  const handle_: SceneHandle = {
    get status() { return buildStatus(); },
    get disposed() { return disposed; },
    enter,
    follow,
    exit: () => exitTo("push"),
    async replace(input, replaceOptions = {}) {
      if (disposed) return { ok: false, errors: [{ path: "$", message: "The scene has been disposed." }] };
      const candidate = await resolveInput(input, settings, replaceOptions.baseUrl ?? current.baseUrl ?? undefined, replaceOptions.signal);
      if (!candidate.ok) return candidate;
      if (disposed) return { ok: false, errors: [{ path: "$", message: "The scene has been disposed." }] };
      // Validated: now swap. Removing the active scene ends navigation at a valid overview.
      operation?.abort(new DOMException("The scene was replaced.", "AbortError"));
      if (immersion) {
        const state = immersion;
        runtime.restoreNavigationSnapshot(state.lease.overview, state.lease);
        teardownImmersion("exit");
        state.lease.release("replaced");
      }
      generation += 1;
      unmount();
      current = candidate.scene;
      phase = "overview";
      target = null;
      lastError = null;
      historyStarted = false;
      overviewState = current.overview && options.applyOverview !== false ? "pending" : "none";
      mount(current);
      return { ok: true };
    },
    async showOverview(overviewOptions = {}) {
      if (disposed) return { ok: false, reason: "disposed", message: "The scene has been disposed." };
      const overview = current.overview;
      if (!overview) return { ok: false, reason: "unavailable", message: "This scene has no overview." };
      if (immersion) return { ok: false, reason: "busy", message: "Exit the panorama first." };
      let ground = overview.target.height?.meters ?? runtime.surface.sample(overview.target.latitudeDeg, overview.target.longitudeDeg)?.heightMeters ?? null;
      if (ground === null) {
        overviewState = "pending";
        emit();
        try {
          const prepared = await runtime.prepareTerrain({
            latDeg: overview.target.latitudeDeg, lonDeg: overview.target.longitudeDeg,
            radiusMeters: Math.max(overview.distanceMeters * 2, 200), altitudeAboveGroundMeters: 0, clearanceMeters: 0,
            signal: overviewOptions.signal,
          });
          ground = prepared.groundHeightMeters;
        } catch (error) {
          return failure(error, overviewOptions.signal ?? new AbortController().signal);
        }
      }
      if (!runtime.restoreNavigationSnapshot(snapshotFromOverview(overview, ground))) return { ok: false, reason: "busy", message: "Another owner holds the camera." };
      overviewState = "applied";
      appliedOverviewFov = true;
      emit();
      return { ok: true };
    },
    hotspots() {
      const state = immersion;
      if (!state || phase !== "immersive") return [];
      const frame = renderer.cameraFrame(runtime.getPresentationView());
      if (!frame) return [];
      const out: { id: string; label: string; x: number; y: number }[] = [];
      for (const link of state.shown.entry.record.links) {
        if (!link.direction || !entries.has(link.target)) continue;
        const presented = presentationFromView(state.shown.entry.frame, [0, 0, 0], { headingDeg: link.direction.headingDeg, pitchDeg: link.direction.pitchDeg, rollDeg: 0, verticalFovDeg: 60 });
        const point = renderer.project([presented.forward.x, presented.forward.y, presented.forward.z], frame);
        if (point) out.push({ id: link.id, label: link.label, x: point.x, y: point.y });
      }
      return out;
    },
    pick(clientX, clientY) {
      if (immersion || disposed) return [];
      return renderer.pick(clientX, clientY, (eye, direction, distance) => {
        const hit = runtime.surface.raycast({ x: eye[0], y: eye[1], z: eye[2] }, { x: direction[0], y: direction[1], z: direction[2] }, distance);
        return hit !== null;
      }).map(hit => hit.id);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(buildStatus());
      return () => { listeners.delete(listener); };
    },
    onFrame(listener) {
      frameListeners.add(listener);
      return () => { frameListeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      operation?.abort(new DOMException("The scene was disposed.", "AbortError"));
      if (immersion) {
        const state = immersion;
        runtime.restoreNavigationSnapshot(state.lease.overview, state.lease);
        teardownImmersion("dispose");
        state.lease.release("disposed");
      }
      disposed = true;
      phase = "disposed";
      if (lookHistoryTimer) clearTimeout(lookHistoryTimer);
      for (const cleanup of cleanups.splice(0)) cleanup();
      frameCallbacks.clear();
      unmount();
      uploader?.cancelAll("The scene was disposed.");
      resources.dispose();
      renderer.dispose();
      if (appliedOverviewFov) {
        // The overview's field of view was the scene's; give the camera back the user's.
        const snapshot = runtime.captureNavigationSnapshot();
        const fov = settings.get("camera.fieldOfView");
        if (snapshot && typeof fov === "number") runtime.restoreNavigationSnapshot({ ...snapshot, camera: { ...snapshot.camera, fov: fov * DEG_TO_RAD } });
      }
      const status = buildStatus();
      for (const listener of [...listeners]) listener(status);
      listeners.clear();
      frameListeners.clear();
      internalListeners.clear();
      runtime.requestRender();
    },
  };

  mount(current);
  return handle_;
}

