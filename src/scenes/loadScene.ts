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
 *
 * With `scene.panorama.flightDuration`, entering flies the globe camera into
 * the orb and exiting pulls it back out (panoramaFlight.ts).
 */
import type { Scene } from "@babylonjs/core";
import type { ActionIntentFrame } from "@felipegalind0/gamepad-tools/core";
import type { BabylonRuntime } from "../engine/babylon/createBabylonRuntime";
import type { FrameProfiler } from "../perf/frameProfiler";
import type { NavigationLease, NavigationPresentation, NavigationSnapshot } from "../engine/babylon/navigationLease";
import { createPanoramaRenderer, effectiveOrbRadius, type ImmersionSource, type PanoramaOrb, type PanoramaRenderer, type PanoramaRendererExperiments, type TiledSourceTextures } from "../engine/babylon/panorama/panoramaRenderer";
import { createPanoramaUploader, type PanoramaGpuTexture, type PanoramaUploader } from "../engine/babylon/panorama/panoramaTextures";
import { createPanoramaTileAtlas } from "../engine/babylon/panorama/panoramaTileAtlas";
import { getAppSettings } from "../settings/appSettings";
import type { SettingsRegistry } from "../settings/registry";
import { isNumberRange } from "../settings/values";
import { RENDERER_EXPERIMENT_IDS } from "../settings/catalogue/renderer";
import { SCENE_PARAMETERS } from "../settings/catalogue/scenes";
import { chooseRepresentation, MIB, representationAroundPx, representationFaceTexels, representationGpuBytes, representationMaxSide, tileAtlasLayout, tiledCubeTileCount } from "./budget";
import type { AttributionRecord, ResolvedAsset, ResolvedPanorama, ResolvedRepresentation, ResolvedTiledCube, SceneDiagnostic, ValidatedScene, ViewRecord } from "./format";
import { createTiledPanorama, type TiledPanoramaLimits } from "./tiles/tiledPanorama";
import type { TileSelectionParameters, TileView } from "./tiles/tileSelection";
import { isSafariGestureSupported } from "../input/safariGestures";
import { watchWheelGestures } from "../input/wheelController";
import type { HeldPress } from "../input/mouseController";
import { DEFAULT_INERTIA_DECAY_PER_FRAME } from "../input/inertialCameraController";
import { attachLookInput, createLookModel, type LookModel, type LookSettings, type LookState } from "./panoramaInput";
import {
  captureRelativeMarker,
  contentMatrix,
  DEG_TO_RAD,
  dot,
  ecef,
  enuFrame,
  expansionTargetRadius,
  groundQueryPoint,
  groundRelativeMarker,
  handoffReady,
  immersionFaceTexels,
  length,
  mulMat3,
  orbGeometry,
  previewFaceTexels,
  scale,
  sub,
  vec3,
  type EnuFrame,
  type Mat3,
  type Vec3,
} from "./panoramaMath";
import { flightIn, flightMotion, flightOut, glideSettling, poseView, type Flight, type FlightPose } from "./panoramaFlight";
import { sceneMediaStore, setSceneMediaLimits } from "./mediaStore";
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
const TILE_SECTION = "render/scenes/tiles";
const TILE_UPLOAD_SECTION = "render/scenes/tiles/upload";

// ─── Public types ──────────────────────────────────────────────────────

/** What a scene needs from the runtime: the public `foss-earth/runtime` surface. */
export type SceneRuntime = Pick<BabylonRuntime,
  | "surface" | "acquireNavigation" | "captureNavigationSnapshot" | "restoreNavigationSnapshot"
  | "getPresentationView" | "setNavigationIntentHandler" | "requestRender" | "beginContinuous" | "endContinuous"
  | "onDeviceLost" | "onDeviceRestored" | "prepareTerrain"> & Partial<Pick<BabylonRuntime, "getInputMode" | "placeNavigationCamera" | "getCameraHandling" | "glideNavigationCamera">> & {
    scene?: Scene;
    /** Where the scene's own frame work is timed, when the runtime profiles. */
    frameProfile?: { profiler: FrameProfiler };
  };

export type ScenePhase = "overview" | "preparing" | "entering" | "immersive" | "exiting" | "disposed";

/** One image a panorama offers: a representation of its asset. */
export interface SceneImageStatus {
  id: string;
  role: "preview" | "immersion";
  projection: "cube" | "equirectangular" | "tiled-cube";
  /** A tiled cube's warp. */
  warp?: "equi-angular" | "gnomonic";
  /** A tiled cube's tile count. */
  tiles?: number;
  /** Pixels: an equirectangular image's width and height, or a cube face's side twice, a tiled cube's finest. */
  width: number;
  height: number;
  /** Pixels around the whole turn: an equirectangular image's width, or four cube faces. */
  aroundPx: number;
  encodedBytes: number;
  /** GPU bytes once uploaded with its mips; a tiled cube's atlas, which holds part of it. */
  gpuBytes: number;
}

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
  capture: { longitudeDeg: number; latitudeDeg: number; heightMeters: number | null; horizontalAccuracyMeters: number | null };
  /** The image's pose, and whether its heading was set against north: null when the scene does not say. */
  pose: { headingDeg: number; pitchDeg: number; rollDeg: number; aligned: boolean | null };
  attribution: AttributionRecord | null;
  /** Every image its asset offers, smallest first. */
  images: SceneImageStatus[];
  links: { id: string; label: string; target: string; enabled: boolean; placed: boolean }[];
}

/** Which image of the panorama on screen is shown, and why no larger one is. */
export interface ImmersionDetailStatus {
  representation: string;
  /** Why no larger image is on screen, a limit or a failed load; null when this is the largest the panorama offers. */
  limitation: string | null;
  /** A larger or smaller image on its way to replace it, while it loads. */
  loading: string | null;
  /** While a tiled cube is on screen: how much of the view its tiles cover. */
  tiles?: {
    /** Tiles the view needs, and how many are on screen. */
    inView: number;
    shownInView: number;
    /** The finest level the view asks for, and the cube's finest. */
    levelWanted: number;
    finestLevel: number;
    loading: number;
    /** Bytes downloaded for tiles, and the tiles that came from the images kept between visits instead. */
    receivedBytes: number;
    reusedTiles: number;
    /** Tiles held in the atlas, and its slots. */
    resident: number;
    slots: number;
    complete: boolean;
  };
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
  /** The orb under the pointer in the overview, which grows if its style asks. */
  hovered: string | null;
  entries: SceneEntryStatus[];
  groups: { id: string; title: string; members: string[] }[];
  /** Credits for what is on screen now. */
  credits: (AttributionRecord & { assetId: string })[];
  immersionDetail: ImmersionDetailStatus | null;
  overview: "none" | "pending" | "applied";
  renderingAvailable: boolean;
  unavailableReason: string | null;
  warnings: readonly SceneDiagnostic[];
  lastError: string | null;
  view: LookState | null;
}

/**
 * Something the scene could not do, told to the host as it happens so its log
 * can say so: the scene file, an orb's preview, entering a panorama, or a
 * larger image of the one on screen. Cancelled work is not a failure, and
 * neither is a larger image held back by a limit the user set.
 */
export interface SceneFailure {
  kind: "scene" | "preview" | "navigation" | "image";
  /** The panorama it concerns, if any. */
  panorama: { id: string; title: string } | null;
  /** What went wrong, as the network or the loader said it. */
  cause: string;
  /** One sentence for a log: what failed, and the cause. */
  message: string;
}

/** Network progress, before a complete image can be decoded and shown. */
export interface SceneProgress {
  /** Stable for a manifest URL or a representation in this scene generation. */
  id: string;
  kind: "manifest" | "preview" | "image";
  title: string;
  receivedBytes: number;
  totalBytes: number | null;
  state: "loading" | "ready" | "failed" | "cancelled";
}

export type SceneActionResult =
  | { ok: true }
  | { ok: false; reason: "disposed" | "busy" | "cancelled" | "unavailable" | "failed"; message: string };

export interface EnterOptions {
  /** Cancels the entry while it is under way. */
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
  /** The orb a pointer is over, or null: it grows to its style's hover scale. Only in the overview. */
  hover(id: string | null): void;
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
  /** Told of each failure as it happens, for the host's log. */
  onFailure?: (failure: SceneFailure) => void;
  /** Actual response bytes as they arrive; previews and entered images load independently. */
  onProgress?: (progress: SceneProgress) => void;
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
async function fetchManifest(url: URL, maxBytes: number, signal?: AbortSignal, onProgress?: (progress: SceneProgress) => void): Promise<{ text: string; baseUrl: string } | { error: string }> {
  let received = 0;
  let totalBytes: number | null = null;
  const publish = (state: SceneProgress["state"]): void => onProgress?.({ id: url.href, kind: "manifest", title: url.href, receivedBytes: received, totalBytes, state });
  publish("loading");
  try {
    const response = await fetch(url, { credentials: "omit", signal });
    if (!response.ok) throw new Error(`answered ${response.status}`);
    const announced = Number(response.headers.get("content-length"));
    // Content-Length describes the compressed body when content encoding is present.
    if (announced > 0 && Number.isFinite(announced) && !response.headers.get("content-encoding")) totalBytes = announced;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("has no body");
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal?.aborted) throw signal.reason;
        received += value.byteLength;
        if (received > maxBytes) throw new Error(`passed the ${maxBytes}-byte manifest limit (scene.manifestMiB) while arriving`);
        chunks.push(value);
        publish("loading");
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    }
    if (signal?.aborted) throw signal.reason;
    const bytes = new Uint8Array(received);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    totalBytes = received;
    publish("ready");
    return { text: new TextDecoder().decode(bytes), baseUrl: response.url || url.href };
  } catch (error) {
    publish(signal?.aborted ? "cancelled" : "failed");
    return { error: `${url.href} could not be fetched: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function resolveInput(input: SceneInput, settings: SettingsRegistry, baseUrl: string | URL | undefined, signal?: AbortSignal, onProgress?: (progress: SceneProgress) => void): Promise<{ ok: true; scene: ValidatedScene } | { ok: false; errors: readonly SceneDiagnostic[] }> {
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
    const fetched = await fetchManifest(url, limits.manifestBytes, signal, onProgress);
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
  const resolved = await resolveInput(input, settings, options.baseUrl, options.signal, options.onProgress);
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
  /** A sharper preview that failed to load: not asked for again, frame after frame, while the orb stays as large. */
  failedSharper?: string | null;
  /** Since when, `now()`, the orb has been drawn needing a smaller preview than it shows, or not drawn at all. */
  unneededSince?: number | null;
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
  /** Tiles loading behind a sharper image on screen, before they crossfade in. */
  incoming: { handle: SourceHandle<PanoramaGpuTexture>; entry: Entry } | null;
  /** Tiled cubes that failed in this panorama: it shows whole images instead. */
  failedTiles: Set<string>;
  detail: Omit<ImmersionDetailStatus, "tiles">;
  refine: AbortController | null;
  look: LookModel;
  roll: number;
  input: { applyIntents(frame: ActionIntentFrame): void; detach(): void };
  offIntents: () => void;
  offLeaseAbort: () => void;
  /** Stops stepping held keys, sticks and a glide. */
  stopLook: () => void;
  /** Set once exiting begins: the view no longer follows the look. */
  leaving: boolean;
  session: string;
}

/** A flight under way, as far as it has got: what a cut needs to carry it on. */
interface Flying {
  flight: Flight;
  marker: Vec3;
  durationMs: number;
  /** When it began, `now()`: input begun since is the person's, taking the camera over. */
  startedMs: number;
  /** The animation's time, 0 to 1, at the last frame drawn. */
  t: number;
  /** The overlay's opacity at eased progress `s`. */
  reveal(s: number): number;
  source?: ImmersionSource;
}

let sessionCounter = 0;

/** An asset's images, smallest first, as the panorama's tab lists them; a tiled cube's GPU bytes are its atlas's. */
function imagesOf(asset: ResolvedAsset, tileMemoryBytes: number, maxTextureSide: number): SceneImageStatus[] {
  return asset.representations
    .map(representation => ({
      id: representation.id,
      role: representation.role,
      projection: representation.projection,
      ...(representation.projection === "tiled-cube" ? { warp: representation.warp, tiles: tiledCubeTileCount(representation) } : {}),
      width: representation.projection === "equirectangular" ? representation.width : representation.faceSize,
      height: representation.projection === "equirectangular" ? representation.height : representation.faceSize,
      aroundPx: representationAroundPx(representation),
      encodedBytes: representation.encodedBytes,
      gpuBytes: representationGpuBytes(representation, tileMemoryBytes, maxTextureSide),
    }))
    .sort((a, b) => a.aroundPx - b.aroundPx || a.gpuBytes - b.gpuBytes);
}

/** A tiled cube's kind, as a sentence names it. */
function tilesName(warp: ResolvedTiledCube["warp"]): string {
  return warp === "equi-angular" ? "equi-angular cube tiles" : "cube tiles";
}

/** How the panorama's tab names an image in a sentence. */
function imageName(representation: ResolvedRepresentation): string {
  if (representation.projection === "tiled-cube") return `The ${tilesName(representation.warp)}`;
  return representation.projection === "cube"
    ? `The ${representation.faceSize} px ${representation.role === "preview" ? "preview " : ""}cube`
    : `The ${representation.width} px image`;
}

/** A cause, as the end of a sentence. */
function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

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
  // Seen before any handler can stop them: a wheel gesture under way, such as a swipe's momentum, is not new input.
  const wheels = canvas && typeof window !== "undefined" ? watchWheelGestures(canvas) : null;
  if (wheels) cleanups.push(() => wheels.dispose());
  let current = initialScene;
  let generation = 1;
  let phase: ScenePhase = "overview";
  let target: string | null = null;
  let lastError: string | null = null;
  const report = (kind: SceneFailure["kind"], entry: Entry | null, cause: string, message: string): void => {
    options.onFailure?.({ kind, panorama: entry ? { id: entry.record.id, title: entry.record.title } : null, cause, message });
  };
  /** A navigation error: shown as the scene's last error, and reported. */
  const navigationError = (message: string): void => {
    lastError = message;
    report("navigation", null, message, message);
  };
  let overviewState: SceneStatus["overview"] = current.overview && options.applyOverview !== false ? "pending" : "none";
  let appliedOverviewFov = false;
  let overviewPreparation: AbortController | null = null;
  let overviewPreparedView: NavigationSnapshot["view"] | null = null;
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
  /** How long the camera flies into and out of an orb, ms: 0 when it is off, motion is reduced or the runtime cannot move its camera. */
  const flightDuration = (): number => {
    const value = settings.get("scene.panorama.flightDuration");
    return typeof value === "number" && value > 0 && !reducedMotion() && runtime.placeNavigationCamera ? value : 0;
  };
  const presented = (pose: FlightPose): NavigationPresentation => ({ position: ecef(pose.position), forward: ecef(pose.forward), up: ecef(pose.up), verticalFovRad: pose.verticalFovRad });
  const placeCamera = (lease: NavigationLease, pose: FlightPose): void => {
    runtime.placeNavigationCamera?.(lease, presented(pose));
  };
  const devicePixelsPerCss = () => (engine ? 1 / engine.getHardwareScalingLevel() : 1);
  const lookSettings = (): LookSettings => ({
    dragSensitivity: num("scene.panorama.dragSensitivity"),
    swipeSensitivity: num("scene.panorama.swipeSensitivity"),
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
  // The renderer's work-saving experiments, where the registry has them.
  const experimentIds: Record<keyof PanoramaRendererExperiments, string> = {
    bookkeeping: RENDERER_EXPERIMENT_IDS.panoramaBookkeeping,
    opaqueImmersion: RENDERER_EXPERIMENT_IDS.opaqueImmersion,
    shaders: RENDERER_EXPERIMENT_IDS.panoramaShaders,
  };
  const experiment = (id: string): boolean => settings.has(id) && settings.get(id) === true;
  const panoramaExperiments = (): PanoramaRendererExperiments => ({
    bookkeeping: experiment(experimentIds.bookkeeping),
    opaqueImmersion: experiment(experimentIds.opaqueImmersion),
    shaders: experiment(experimentIds.shaders),
  });
  let setRendererExperiments: ((experiments: PanoramaRendererExperiments) => void) | null = null;
  const renderer: SceneRenderer = options.internals?.renderer ?? (() => {
    const created = createPanoramaRenderer(scene!, {
      getPresentationView: () => runtime.getPresentationView(),
      requestRender: () => runtime.requestRender(),
      onError: cause => report("image", null, cause, `Panoramas could not be drawn: ${sentence(cause)}`),
      ...(profiler ? { profiler } : {}),
      experiments: panoramaExperiments(),
    });
    setRendererExperiments = experiments => created.setExperiments(experiments);
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
  // The browser decodes off the main thread: its wall time runs alongside frames, not in one.
  async function decodeBitmap(bytes: Uint8Array): Promise<ImageBitmap> {
    const started = profiler?.clock() ?? 0;
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { colorSpaceConversion: "none", premultiplyAlpha: "none", imageOrientation: "from-image" });
    if (started) profiler!.add(DECODE_WALL_SECTION, started);
    return bitmap;
  }
  // A rectangle of a decoded image as a bitmap that owns its pixels, unscaled. Through a canvas, and not
  // createImageBitmap's own rectangle: Firefox's WebGL uploads the whole image behind a bitmap cut that way,
  // which a face's texture refuses, so every orb from a preview sheet stayed black there.
  let cropCanvas: OffscreenCanvas | null = null;
  async function cropBitmap(image: ImageBitmap, x: number, y: number, width: number, height: number): Promise<ImageBitmap> {
    const offscreen = typeof OffscreenCanvas === "function";
    // An offscreen canvas hands its picture over at once, so one serves every face; an element's is copied later, so each face has its own.
    const canvas = offscreen ? (cropCanvas ??= new OffscreenCanvas(width, height)) : document.createElement("canvas");
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const context = canvas.getContext("2d", { alpha: false }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) throw new Error("The browser gave no canvas to cut a preview sheet with.");
    context.globalCompositeOperation = "copy";
    context.imageSmoothingEnabled = false;
    context.drawImage(image, x, y, width, height, 0, 0, width, height);
    if (canvas instanceof HTMLCanvasElement) {
      try {
        return await createImageBitmap(canvas, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    return canvas.transferToImageBitmap();
  }
  /** How tiled cubes load: the Scenes tab's tile parameters, the fades and each request's bounds. */
  const tileLimits = (): TiledPanoramaLimits => ({
    requests: Math.max(1, Math.round(num("scene.panorama.tileRequests"))),
    waiting: Math.max(1, Math.round(num("scene.panorama.tilesWaiting"))),
    decodes: Math.max(1, Math.round(num("scene.panorama.tileDecodes"))),
    uploadsPerFrame: Math.max(1, Math.round(num("scene.panorama.tileUploadsPerFrame"))),
    retries: Math.max(0, Math.round(num("scene.panorama.tileRetries"))),
    retryDelayMs: num("scene.panorama.tileRetryDelay"),
    fadeMs: reducedMotion() ? num("scene.panorama.reducedFadeDuration") : num("scene.panorama.fadeDuration"),
    timeoutMs: num("scene.panorama.requestTimeout") * 1000,
    responseBytes: num("scene.panorama.responseMiB") * MIB,
  });
  const uploadLimits = () => ({ bytesPerFrame: num("scene.panorama.uploadMiBPerFrame") * MIB, outstandingBytes: num("scene.panorama.uploadOutstandingMiB") * MIB });
  const backend: ResourceBackend<PanoramaGpuTexture> = options.internals?.backend ?? (() => {
    const gpuUploader = scene && renderer.available ? createPanoramaUploader(scene, uploadLimits(), () => runtime.requestRender()) : null;
    uploader = gpuUploader;
    const refuse = () => Promise.reject(new ResourceRefusal(renderer.unavailableReason ?? "Panoramas are unavailable on this renderer.", "device"));
    return {
      fetch: (url, init) => fetch(url, init),
      decode: bytes => decodeBitmap(bytes),
      // Allocating the texture and queueing its rows: what finishing a decode costs the frame.
      uploadCube: (faces, label) => (gpuUploader ? timedCall(DECODE_COMPLETION_SECTION, () => gpuUploader.uploadCube(faces, label)) : refuse()),
      // A face out of a preview sheet: the same pixels, no resampling and no second decode.
      crop: cropBitmap,
      uploadEquirect: (image, label) => (gpuUploader ? timedCall(DECODE_COMPLETION_SECTION, () => gpuUploader.uploadEquirect(image, label)) : refuse()),
      async createTiles(representation, layout, label, saved) {
        if (!scene || !gpuUploader) return refuse();
        const cells = representation.faceSize / representation.tileSize;
        const atlas = createPanoramaTileAtlas(scene, layout, cells, label);
        const textures: TiledSourceTextures = {
          atlas: atlas.atlas, table: atlas.table, layout: [cells, representation.tileSize, representation.gutter, layout.stored],
          atlasSize: [layout.width, layout.height], warp: representation.warp, outlines: settings.get("scene.panorama.tileOutlines") === true,
        };
        const panorama = createTiledPanorama<ImageBitmap>({
          representation, layout,
          // Copying a tile into the atlas is a frame's work, timed with the uploads.
          atlas: { uploadTile: (slot, image) => timedCall(TILE_UPLOAD_SECTION, () => atlas.uploadTile(slot, image)), setTable: bytes => atlas.setTable(bytes), dispose: () => atlas.dispose() },
          fetch: (url, init) => fetch(url, init),
          decode: bytes => decodeBitmap(bytes),
          release: image => image.close(),
          limits: tileLimits(),
          wake: () => runtime.requestRender(),
          saved,
        });
        return {
          kind: "tiles", width: representation.faceSize, height: representation.faceSize, levels: representation.levelBytes.length,
          gpuBytes: layout.gpuBytes, texture: atlas.atlas, complete: true, tiles: { panorama, textures },
          dispose: () => panorama.dispose(),
        };
      },
      maxTextureSide: deviceMaxSide,
      media: sceneMediaStore,
    };
  })();
  // What may be kept between visits: the page's one store follows the parameter.
  const applySavedLimit = (): void => setSceneMediaLimits({ maxBytes: num("scene.panorama.savedMiB") * MIB });
  applySavedLimit();
  cleanups.push(settings.watch("scene.panorama.savedMiB", applySavedLimit));
  const resources = createPanoramaResources(backend, resourceSettingsFrom(id => settings.get(id), detailCap()), progress => {
    if (disposed) return;
    const entry = [...entries.values()].find(entry => entry.asset.id === progress.assetId && entry.asset.representations.includes(progress.representation));
    if (!entry) return;
    options.onProgress?.({
      id: `${generation}/${progress.id}`, kind: progress.representation.role === "preview" ? "preview" : "image",
      title: entry.record.title, receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes, state: progress.state,
    });
  });

  // One frame driver: scene frames in the app, a test's ticker otherwise.
  const frameCallbacks = new Set<() => void>();
  const onFrame = options.internals?.onFrame ?? ((callback: () => void) => {
    const observer = scene!.onBeforeRenderObservable.add(callback);
    return () => { scene!.onBeforeRenderObservable.remove(observer); };
  });
  const offFrame = onFrame(() => {
    const started = profiler?.clock() ?? 0;
    timedCall(UPLOAD_SECTION, () => uploader?.pump());
    timedCall(TILE_SECTION, tickTiles);
    for (const callback of [...frameCallbacks]) callback();
    timedCall(PLACEMENT_SECTION, () => { refreshPlacements(); tryApplyOverview(); sharpenPreviews(); });
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
          capture: { longitudeDeg: 0, latitudeDeg: 0, heightMeters: null, horizontalAccuracyMeters: null },
          pose: { headingDeg: 0, pitchDeg: 0, rollDeg: 0, aligned: null }, attribution: null, images: [], links: [],
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
        capture: {
          longitudeDeg: record.capture.longitudeDeg, latitudeDeg: record.capture.latitudeDeg,
          heightMeters: record.capture.height?.meters ?? null, horizontalAccuracyMeters: record.capture.horizontalAccuracyMeters ?? null,
        },
        pose: { headingDeg: record.imagePose.headingDeg, pitchDeg: record.imagePose.pitchDeg, rollDeg: record.imagePose.rollDeg, aligned: record.imagePose.aligned ?? null },
        attribution: { ...entry.asset.attribution },
        images: imagesOf(entry.asset, num("scene.panorama.tileMemoryMiB") * MIB, deviceMaxSide()),
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
      hovered,
      entries: list,
      groups: current.groups.map(group => ({ id: group.id, title: group.title, members: [...group.members] })),
      credits: [...visibleAssets].map(assetId => ({ assetId, ...current.assets.get(assetId)!.attribution })),
      immersionDetail: immersion ? { ...immersion.detail, ...tileStatus(immersion) } : null,
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
        outline: record.markerStyle.outline,
        displayScale: 1,
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
      else {
        entry.preview.state = "failed";
        entry.preview.message = renderer.unavailableReason;
      }
    }
    refreshPlacements();
    emit();
    // The current camera may be far from this scene: sampling only displayed
    // terrain cannot make that destination load. Prepare it independently of
    // the image queue and apply as soon as its centre is available.
    if (overviewState === "pending") void handle_.showOverview();
  }

  function unmount(): void {
    stopWarming();
    overviewPreparation?.abort();
    overviewPreparation = null;
    overviewPreparedView = null;
    resetHover();
    for (const entry of entries.values()) {
      entry.preview.controller?.abort();
      entry.preview.handle?.release();
      entry.orb.dispose();
    }
    entries = new Map();
  }

  /**
   * The preview for an orb drawn `diameterPx` device pixels across, at the
   * asked density, within its range and the budget; null asks for the
   * smallest allowed, an orb's first.
   */
  function choosePreview(entry: Entry, diameterPx: number | null): { representation: ResolvedRepresentation; limitation: string | null } | null {
    const faces = range("scene.panorama.previewFaceRange");
    const wanted = diameterPx === null ? faces.min : previewFaceTexels(diameterPx, previewHalfAngle(), num("scene.panorama.previewDensity"));
    const previews = entry.asset.representations.filter(rep => rep.role === "preview" && rep.projection === "cube");
    const inRange = previews.filter(rep => rep.projection === "cube" && rep.faceSize >= faces.min && rep.faceSize <= faces.max);
    const pool = inRange.length > 0 ? inRange : previews;
    const choice = chooseRepresentation(pool, "preview", Math.min(Math.max(wanted, faces.min), faces.max), rep => (resources.wouldFit(rep) ? null : "the panorama GPU memory is full (scene.panorama.sourceGpuMiB)"));
    if (!choice) return null;
    const outOfRange = inRange.length === 0 ? `no preview is within ${faces.min}–${faces.max} px (scene.panorama.previewFaceRange)` : null;
    return { representation: choice.representation, limitation: [outOfRange, choice.limitation].filter(Boolean).join("; ") || null };
  }

  /**
   * An orb's diameter as it is drawn in `frame`, device px; null while it has
   * no place, or is behind the view or off the screen.
   */
  function drawnDiameterPx(entry: Entry, frame: NonNullable<ReturnType<SceneRenderer["cameraFrame"]>>): number | null {
    const marker = entry.placement.marker;
    if (!marker || entry.placement.state !== "placed") return null;
    const radius = entry.orb.effectiveRadius(frame);
    if (radius === null) return null;
    const rel = sub(marker, frame.eye);
    if (!renderer.project(rel, frame)) return null;
    const distance = Math.max(length(rel), radius);
    return (radius * frame.viewportHeightCssPx) / (distance * Math.tan(frame.view.verticalFovRad / 2)) * devicePixelsPerCss();
  }

  /**
   * Every orb starts with its smallest allowed preview. One drawn with more
   * pixels than that preview has texels loads the preview its size asks for,
   * the largest on screen first; nothing is loaded for a size the orb could
   * reach and has not. One that has needed less than it shows for the
   * preview hold, drawn smaller or out of view, goes back to the preview it
   * needs, so the GPU holds what the map shows.
   */
  function sharpenPreviews(): void {
    if (immersion || !renderer.available || entries.size === 0) return;
    const frame = renderer.cameraFrame();
    if (!frame) return;
    const halfAngle = previewHalfAngle();
    const density = num("scene.panorama.previewDensity");
    const largest = range("scene.panorama.markerDiameter").max * devicePixelsPerCss();
    const smallest = range("scene.panorama.previewFaceRange").min;
    const hold = settings.get("scene.panorama.previewHold");
    // Not while a panorama is being entered or left: its orb's preview is what the flight shows.
    const holdMs = typeof hold === "number" && phase === "overview" && target === null ? hold * 1000 : null;
    const at = now();
    for (const entry of entries.values()) {
      const { preview } = entry;
      if (preview.state !== "ready" || preview.controller || !preview.handle) continue;
      const diameter = drawnDiameterPx(entry, frame);
      const shown = representationFaceTexels(preview.handle.representation);
      if (diameter !== null && previewFaceTexels(diameter, halfAngle, density) > shown) {
        preview.unneededSince = null;
        // Behind every orb's first preview (1) and an entered image; among themselves, the largest orb first.
        loadPreview(entry, Math.min(0.99, diameter / Math.max(1, largest)), true, diameter);
        continue;
      }
      // Most orbs show their smallest preview: nothing smaller to go back to.
      const needed = holdMs !== null && shown > smallest ? choosePreview(entry, diameter) : null;
      if (!needed || representationFaceTexels(needed.representation) >= shown) {
        preview.unneededSince = null;
        continue;
      }
      preview.unneededSince ??= at;
      if (at - preview.unneededSince >= holdMs!) relaxPreview(entry, needed);
    }
  }

  /**
   * Shows the smaller preview an orb needs now in place of the sharper one,
   * which is given up: it stays on the GPU only within what may be kept
   * (scene.panorama.keptGpuMiB), and its files in the saved images.
   */
  function relaxPreview(entry: Entry, choice: { representation: ResolvedRepresentation; limitation: string | null }): void {
    const previous = entry.preview.handle;
    if (!previous) return;
    const controller = new AbortController();
    const loadingGeneration = generation;
    entry.preview = { ...entry.preview, controller, unneededSince: null };
    resources.acquire(entry.asset, choice.representation, { signal: controller.signal, priority: 0 }).then(handle => {
      if (disposed || loadingGeneration !== generation || entries.get(entry.record.id) !== entry || controller.signal.aborted) {
        handle.release();
        return;
      }
      entry.preview = { state: "ready", handle, limitation: choice.limitation, message: null, controller: null, failedSharper: entry.preview.failedSharper ?? null };
      entry.orb.update({ texture: handle.texture.texture });
      if (immersion?.shown.handle !== previous) previous.release();
      runtime.requestRender();
      emit();
    }, () => {
      if (disposed || loadingGeneration !== generation || entries.get(entry.record.id) !== entry || controller.signal.aborted) return;
      // It keeps the sharper one, and tries again after another hold.
      entry.preview = { ...entry.preview, controller: null, unneededSince: now() };
    });
  }

  /**
   * Loads an orb's first preview, or with `diameterPx` the sharper one an orb
   * drawn that large needs. `reportFailure` is false when entering waits on
   * it, since entering reports its own failure.
   */
  function loadPreview(entry: Entry, priority: number, reportFailure = true, diameterPx: number | null = null): void {
    const sharpen = diameterPx !== null;
    if (entry.preview.controller || (entry.preview.state === "ready" && !sharpen)) return;
    const previous = entry.preview.handle;
    const failed = (cause: string): void => {
      if (reportFailure) report("preview", entry, cause, previous
        ? `${entry.record.title}: its sharper preview could not be loaded: ${sentence(cause)} The current preview remains available.`
        : `${entry.record.title}: its preview could not be loaded: ${sentence(cause)}`);
    };
    const choice = choosePreview(entry, diameterPx);
    if (!choice) {
      if (previous) return;
      entry.preview = { ...entry.preview, state: "failed", message: "No preview fits the panorama GPU memory (scene.panorama.sourceGpuMiB)." };
      failed(entry.preview.message!);
      emit();
      return;
    }
    // Only ever sharper: nothing smaller is loaded to take a preview's place, and one that failed is left alone.
    if (previous && (representationFaceTexels(choice.representation) <= representationFaceTexels(previous.representation) || entry.preview.failedSharper === choice.representation.id)) return;
    const controller = new AbortController();
    const loadingGeneration = generation;
    entry.preview = { ...entry.preview, state: previous ? "ready" : "loading", handle: previous, limitation: choice.limitation, message: null, controller };
    emit();
    resources.acquire(entry.asset, choice.representation, { signal: controller.signal, priority }).then(handle => {
      // A late arrival for a replaced or disposed scene is released, never shown.
      if (disposed || loadingGeneration !== generation || entries.get(entry.record.id) !== entry || controller.signal.aborted) {
        handle.release();
        return;
      }
      entry.preview = { state: "ready", handle, limitation: choice.limitation, message: null, controller: null };
      entry.orb.update({ texture: handle.texture.texture });
      // A panorama still showing the smaller preview keeps it, and releases it when it shows something else.
      if (previous && immersion?.shown.handle !== previous) previous.release();
      runtime.requestRender();
      emit();
    }, error => {
      if (disposed || loadingGeneration !== generation || controller.signal.aborted) return;
      entry.preview = {
        state: previous ? "ready" : "failed", handle: previous, limitation: null, message: error instanceof Error ? error.message : String(error), controller: null,
        ...(previous ? { failedSharper: choice.representation.id } : {}),
      };
      failed(entry.preview.message!);
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
    if (overviewCameraMoved()) { cancelPendingOverview(); return; }
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
      overviewPreparation?.abort();
      overviewPreparation = null;
      overviewPreparedView = null;
      emit();
    }
  }

  /** Includes gamepad steering and host camera changes that have no DOM gesture. */
  function overviewCameraMoved(): boolean {
    if (!overviewPreparedView) return false;
    const view = runtime.captureNavigationSnapshot()?.view;
    return Boolean(view && (view.latDeg !== overviewPreparedView.latDeg || view.lonDeg !== overviewPreparedView.lonDeg
      || view.headingDeg !== overviewPreparedView.headingDeg || view.pitchDeg !== overviewPreparedView.pitchDeg
      || view.zoomMeters !== overviewPreparedView.zoomMeters));
  }

  function cancelPendingOverview(): void {
    if (overviewState !== "pending") return;
    overviewState = "none";
    overviewPreparation?.abort();
    overviewPreparation = null;
    overviewPreparedView = null;
    emit();
  }

  // A delayed terrain result never takes the camera back from the person.
  // Listen before the globe handles the same gesture, without consuming it.
  if (canvas && typeof window !== "undefined") {
    const onOverviewInput = (event: Event): void => {
      if (event.type === "keydown") {
        if ((event as KeyboardEvent).repeat || (document.activeElement !== canvas && event.target !== canvas)) return;
      } else {
        const target = event.target as Node | null;
        if (target !== canvas && !(target && canvas.contains(target))) return;
        if (event.type === "wheel" && !wheels?.begins()) return;
      }
      cancelPendingOverview();
    };
    for (const type of ["pointerdown", "wheel", "keydown", "gesturestart"]) {
      window.addEventListener(type, onOverviewInput, { capture: true, passive: true });
      cleanups.push(() => window.removeEventListener(type, onOverviewInput, { capture: true }));
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

  // ─── Hover ──────────────────────────────────────────────────────────
  // The orb under the pointer grows to its style's hover scale, and the one
  // it left shrinks back, each over `scene.panorama.hoverDuration`.
  let hovered: string | null = null;
  /** How far each orb that is not at rest has grown, 0–1. */
  const hoverAmounts = new Map<string, number>();
  let hoverLastMs = 0;
  let hoverRendering: (() => void) | null = null;
  function setHovered(id: string | null): void {
    const next = id !== null && phase === "overview" && entries.has(id) ? id : null;
    if (next === hovered) return;
    hovered = next;
    if (next && entries.get(next)!.record.markerStyle.hoverScale > 1 && !hoverAmounts.has(next)) hoverAmounts.set(next, 0);
    if (hoverAmounts.size && !hoverRendering) {
      hoverLastMs = now();
      frameCallbacks.add(stepHover);
      runtime.beginContinuous();
      hoverRendering = () => { frameCallbacks.delete(stepHover); runtime.endContinuous(); };
    }
    emit();
  }
  function stepHover(): void {
    const at = now();
    const duration = reducedMotion() ? 0 : num("scene.panorama.hoverDuration");
    const change = duration > 0 ? (at - hoverLastMs) / duration : 1;
    hoverLastMs = at;
    for (const [id, amount] of hoverAmounts) {
      const entry = entries.get(id);
      const goal = id === hovered ? 1 : 0;
      const next = goal > amount ? Math.min(goal, amount + change) : Math.max(goal, amount - change);
      entry?.orb.update({ displayScale: 1 + (entry.record.markerStyle.hoverScale - 1) * smooth(next) });
      if (!entry || (next === 0 && goal === 0)) hoverAmounts.delete(id);
      else hoverAmounts.set(id, next);
    }
    if ([...hoverAmounts].every(([id, amount]) => amount === (id === hovered ? 1 : 0))) {
      hoverRendering?.();
      hoverRendering = null;
    }
  }
  /** Every orb back to its size at once: on entering, and when the scene's orbs go. */
  function resetHover(): void {
    hovered = null;
    for (const id of hoverAmounts.keys()) entries.get(id)?.orb.update({ displayScale: 1 });
    hoverAmounts.clear();
    hoverRendering?.();
    hoverRendering = null;
  }

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
  // Reasons an operation stops for another navigation or a new scene: a flight under way then gives way where it is, at once.
  const givingWay = new WeakSet<object>();
  const giveWay = (message: string): DOMException => {
    const reason = new DOMException(message, "AbortError");
    givingWay.add(reason);
    return reason;
  };
  const gaveWay = (signal: AbortSignal): boolean => typeof signal.reason === "object" && signal.reason !== null && givingWay.has(signal.reason);

  function beginOperation(signal?: AbortSignal): AbortController {
    overviewPreparation?.abort();
    overviewPreparation = null;
    if (overviewState === "pending") overviewState = "none";
    operation?.abort(giveWay("Replaced by another navigation."));
    const controller = new AbortController();
    operation = controller;
    signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    return controller;
  }

  /**
   * The orb's preview, loaded if it is not yet; and, on its way from here,
   * the largest preview allowed, since the entry opens the orb's image out
   * across the whole view. That one replaces the orb's image whenever it
   * arrives, so everything after this reads `entry.preview.handle` when it
   * draws, never a handle kept from before.
   */
  async function ensurePreview(entry: Entry, signal: AbortSignal): Promise<SourceHandle<PanoramaGpuTexture>> {
    if (entry.preview.state === "ready") {
      // A sharper preview on its way for the orb's size on the map gives way to the largest.
      entry.preview.controller?.abort();
      entry.preview.controller = null;
    }
    if (entry.preview.state !== "ready") {
      entry.preview.controller?.abort();
      entry.preview = { ...entry.preview, state: "idle", controller: null };
      loadPreview(entry, 10, false);
    }
    while (entry.preview.state === "loading") {
      await new Promise<void>((resolve, reject) => {
        const unsubscribe = subscribeInternal(() => { if (entry.preview.state !== "loading") { unsubscribe(); resolve(); } });
        signal.addEventListener("abort", () => { unsubscribe(); reject(signal.reason); }, { once: true });
      });
    }
    if (entry.preview.state !== "ready" || !entry.preview.handle) throw new Error(entry.preview.message ?? `${entry.record.title} has no preview.`);
    loadPreview(entry, 10, false, Number.POSITIVE_INFINITY);
    return entry.preview.handle;
  }

  /** `what` failed, as in "Northrop Mall could not be entered". */
  function failure(error: unknown, signal: AbortSignal, entry: Entry | null, what: string): SceneActionResult {
    if (disposed) return { ok: false, reason: "disposed", message: "The scene has been disposed." };
    if (signal.aborted) return { ok: false, reason: "cancelled", message: "Cancelled." };
    const message = error instanceof Error ? error.message : String(error);
    lastError = message;
    report("navigation", entry, message, `${what}: ${sentence(message)}`);
    return { ok: false, reason: "failed", message };
  }

  function sourceOf(entry: Entry, handle: SourceHandle<PanoramaGpuTexture>): ImmersionSource {
    const tiles = handle.texture.tiles;
    // A tiled cube draws over the preview cube it holds.
    if (tiles && handle.fallback) return { texture: handle.fallback.texture.texture, kind: "tiles", content: entry.content, tiles: tiles.textures };
    return { texture: handle.texture.texture, kind: handle.texture.kind, content: entry.content };
  }

  // ─── Tiles ──────────────────────────────────────────────────────────
  /** The view in an image's own axes, as tile selection takes it. */
  function tileViewOf(frame: NonNullable<ReturnType<SceneRenderer["cameraFrame"]>>, content: Mat3, heightPx: number): TileView {
    const tanHalfHeight = Math.tan(frame.view.verticalFovRad / 2);
    return {
      forward: mulMat3(content, frame.view.forward), right: mulMat3(content, frame.view.right), up: mulMat3(content, frame.view.up),
      tanHalfHeight, tanHalfWidth: tanHalfHeight * frame.view.aspect, heightPx,
    };
  }

  /** The levels a tiled cube may show: the sharpness target, and the image detail as its finest level. */
  function tileParameters(representation: ResolvedTiledCube): TileSelectionParameters {
    const target = settings.get("scene.panorama.immersionDensity");
    const cap = detailCap();
    const finest = representation.levelBytes.length - 1;
    // Level l's faces are tileSize · 2^l texels, four of them around the turn.
    const levelCap = Number.isFinite(cap) ? Math.max(0, Math.min(finest, Math.floor(Math.log2(cap / (4 * representation.tileSize))))) : finest;
    return { texelsPerPixel: typeof target === "number" ? target : 1, marginDeg: num("scene.panorama.tileMarginDeg"), levelCap };
  }

  /** The tiled cubes the view feeds: the one on screen, and one loading behind a sharper image. */
  function liveTiles(state: Immersion): { handle: SourceHandle<PanoramaGpuTexture>; entry: Entry }[] {
    return [state.shown, state.incoming].filter((each): each is { handle: SourceHandle<PanoramaGpuTexture>; entry: Entry } => Boolean(each?.handle.texture.tiles));
  }

  /**
   * The tiles of a panorama being entered, loading for the view it will open
   * on while the camera is still on its way in: the second the flight takes
   * is most of what the view's tiles need to arrive. The atlas is the one the
   * panorama then shows, found in the resources' cache with its tiles on it.
   */
  let warming: { entry: Entry; view: NavigationPresentation; handle: SourceHandle<PanoramaGpuTexture> | null; controller: AbortController } | null = null;

  function warmTiles(entry: Entry, view: GeoView): void {
    stopWarming();
    if (!renderer.available) return;
    const { representation } = preferredTilesOf(entry.asset, new Set());
    // Where the panorama would not show tiles, nothing is fetched for them.
    if (!representation || !tileAtlasLayout(representation, num("scene.panorama.tileMemoryMiB") * MIB, deviceMaxSide()) || !resources.wouldFit(representation, true)) return;
    const controller = new AbortController();
    const state: NonNullable<typeof warming> = { entry, view: presentation(entry, view), handle: null, controller };
    warming = state;
    resources.acquire(entry.asset, representation, { signal: controller.signal, priority: 5, overlap: true, ...(entry.preview.handle ? { fallback: entry.preview.handle.representation } : {}) }).then(handle => {
      if (warming !== state || controller.signal.aborted) { handle.release(); return; }
      // A cached atlas comes back with the settings of its last use.
      handle.texture.tiles?.panorama.setLimits(tileLimits());
      state.handle = handle;
      runtime.requestRender();
    }, () => {
      // The panorama asks again once it is entered, and says then what went wrong.
      if (warming === state) warming = null;
    });
  }

  /** Ends the warming, or only `entry`'s when another entry may have begun one since: the atlas stays in the cache, with what arrived, for whoever asks next, within what may be kept. */
  function stopWarming(entry?: Entry): void {
    const state = warming;
    if (!state || (entry && state.entry !== entry)) return;
    warming = null;
    state.controller.abort();
    state.handle?.release();
  }

  let tileDigest = "";
  /** One frame of every live tiled cube, with the view as it is drawn this frame; and of one warming, with the view it will open on. */
  function tickTiles(): void {
    const at = now();
    const warm = warming?.handle?.texture.tiles ? warming : null;
    if (warm) {
      const frame = renderer.cameraFrame(warm.view);
      if (frame) {
        const { panorama } = warm.handle!.texture.tiles!;
        const heightPx = engine?.getRenderHeight() ?? frame.viewportHeightCssPx * devicePixelsPerCss();
        if (panorama.tick(at, tileViewOf(frame, warm.entry.content, heightPx), tileParameters(panorama.representation))) runtime.requestRender();
      }
    }
    const state = immersion;
    if (!state || state.leaving) return;
    const live = liveTiles(state);
    if (live.length === 0) return;
    const frame = renderer.cameraFrame(runtime.getPresentationView());
    if (!frame) return;
    const heightPx = engine?.getRenderHeight() ?? frame.viewportHeightCssPx * devicePixelsPerCss();
    let busy = false;
    for (const { handle, entry } of live) {
      const { panorama } = handle.texture.tiles!;
      if (panorama.tick(at, tileViewOf(frame, entry.content, heightPx), tileParameters(panorama.representation))) busy = true;
    }
    if (busy) runtime.requestRender();
    const stats = state.shown.handle.texture.tiles?.panorama.stats();
    const digest = stats ? `${stats.shownInView}/${stats.inView}/${stats.levelWanted}/${stats.loading}/${stats.resident}/${stats.complete}` : "";
    if (digest !== tileDigest) {
      tileDigest = digest;
      emit();
    }
  }

  function tileStatus(state: Immersion): Pick<ImmersionDetailStatus, "tiles"> {
    const tiles = state.shown.handle.texture.tiles;
    if (!tiles) return {};
    const stats = tiles.panorama.stats();
    return {
      tiles: {
        inView: stats.inView, shownInView: stats.shownInView, levelWanted: stats.levelWanted, finestLevel: tiles.panorama.tiling.maxLevel,
        loading: stats.loading, receivedBytes: stats.receivedBytes, reusedTiles: stats.reusedTiles, resident: stats.resident, slots: stats.slots, complete: stats.complete,
      },
    };
  }

  /** Resolves once a tiled cube covers the view, or has nothing more it can load; rejects when `signal` aborts. */
  function tilesCoverView(handle: SourceHandle<PanoramaGpuTexture>, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stop = (): void => { frameCallbacks.delete(check); signal.removeEventListener("abort", onAbort); };
      const onAbort = (): void => { stop(); reject(signal.reason); };
      const check = (): void => {
        const stats = handle.texture.tiles?.panorama.stats();
        if (!stats || stats.complete || (stats.failures > 0 && stats.loading === 0 && stats.waiting === 0)) { stop(); resolve(); }
      };
      if (signal.aborted) { reject(signal.reason); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      frameCallbacks.add(check);
      runtime.requestRender();
    });
  }

  /** Lets go of tiles that were loading behind the image on screen. */
  function dropIncoming(state: Immersion): void {
    state.incoming?.handle.release();
    state.incoming = null;
  }

  /**
   * The tiled cube `scene.panorama.representation` asks for, when the
   * panorama offers one and tiles have not failed in it: the asked-for warp,
   * else the other. `note` says why it is not what was asked for.
   */
  function preferredTiles(state: Immersion): { representation: ResolvedTiledCube | null; note: string | null } {
    return preferredTilesOf(state.shown.entry.asset, state.failedTiles);
  }

  /** The tiled cube of `asset` that the Representation setting asks for, or the one it has; `failed` are left out. */
  function preferredTilesOf(asset: ResolvedAsset, failed: ReadonlySet<string>): { representation: ResolvedTiledCube | null; note: string | null } {
    const preference = settings.get("scene.panorama.representation");
    if (preference === "whole") return { representation: null, note: null };
    const warp: ResolvedTiledCube["warp"] = preference === "cube-tiles" ? "gnomonic" : "equi-angular";
    const offered = asset.representations.filter((rep): rep is ResolvedTiledCube => rep.projection === "tiled-cube" && !failed.has(rep.id));
    const exact = offered.find(rep => rep.warp === warp);
    if (exact) return { representation: exact, note: null };
    if (offered[0]) return { representation: offered[0], note: `This panorama has no ${tilesName(warp)}, so it shows its ${tilesName(offered[0].warp)} (360 image settings → Image).` };
    // A panorama without tiles shows whole images whatever the representation: there is nothing to say.
    return { representation: null, note: null };
  }

  /** Starts immersion in `entry` with `view`: look input, controller intents and lease loss handling. */
  function startImmersion(lease: NavigationLease, entry: Entry, handle: SourceHandle<PanoramaGpuTexture>, view: GeoView, detail: Immersion["detail"]): Immersion {
    // The callbacks below run once the state exists.
    const self: { state: Immersion | null } = { state: null };
    const look = createLookModel({ headingDeg: view.headingDeg, pitchDeg: view.pitchDeg, verticalFovDeg: view.verticalFovDeg }, lookSettings, next => {
      const state = self.state;
      if (!state || immersion !== state || state.leaving) return;
      lease.setPresentationView(presentation(state.shown.entry, geoView(next, state.roll)));
      scheduleLookHistory();
      emit();
    });
    // Held keys and sticks, and a drag's glide, step the view every frame, holding rendering, until they stop.
    let releaseLook: (() => void) | null = null;
    let lookSteppedMs = 0;
    const stopLook = (): void => {
      frameCallbacks.delete(stepLook);
      releaseLook?.();
      releaseLook = null;
    };
    function stepLook(): void {
      const at = now();
      const moving = look.step(at - lookSteppedMs);
      lookSteppedMs = at;
      if (!moving) stopLook();
    }
    const requestFrame = (): void => {
      runtime.requestRender();
      if (releaseLook || !look.moving() || lease.released) return;
      lookSteppedMs = now();
      frameCallbacks.add(stepLook);
      releaseLook = lease.holdRendering();
    };
    // The handoff view is kept exactly: the look model's clamps apply from the first user look.
    const input = canvas
      ? attachLookInput({
        canvas, model: look,
        onExit: () => { void handle_.exit(); },
        onUserInput: () => cancelArrival(),
        requestFrame,
        inputMode: () => runtime.getInputMode?.() ?? "auto",
        safariGestures: isSafariGestureSupported(),
        precedingWheelMs: wheels?.lastEventMs(),
      })
      : { applyIntents() {}, detach() {} };
    const offIntents = runtime.setNavigationIntentHandler(lease, frame => input.applyIntents(frame));
    const onLeaseAbort = (): void => {
      // The runtime ended the lease (device loss or teardown): leave immersion in place of the owner.
      if (self.state && immersion === self.state) teardownImmersion("lease");
    };
    lease.signal.addEventListener("abort", onLeaseAbort, { once: true });
    const state: Immersion = {
      lease, id: entry.record.id, shown: { handle, entry }, incoming: null, failedTiles: new Set(), detail, refine: null, look, roll: view.rollDeg, input, offIntents,
      offLeaseAbort: () => lease.signal.removeEventListener("abort", onLeaseAbort), stopLook, leaving: false, session,
    };
    self.state = state;
    return state;
  }

  let arrival: AbortController | null = null;
  function cancelArrival(): void {
    arrival?.abort(new DOMException("Looking cancels levelling.", "AbortError"));
    arrival = null;
  }

  /**
   * Input that cuts an animation short: Escape, or a press or a new wheel
   * gesture on the canvas. A wheel gesture already under way, such as the
   * momentum of a swipe that turned the image, is not new input. `stop`
   * stops listening; `press` is a mouse press that cut it short.
   */
  function cancelOnInput(op: AbortController): { stop(): void; press(): HeldPress | null } {
    if (typeof window === "undefined") return { stop() {}, press: () => null };
    let held: HeldPress | null = null;
    const cancel = (): void => op.abort(new DOMException("Cancelled by input.", "AbortError"));
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") { event.preventDefault(); cancel(); } };
    const onPress = (event: PointerEvent): void => {
      if (event.pointerType === "mouse") held = { pointerId: event.pointerId, button: event.button, clientX: event.clientX, clientY: event.clientY };
      cancel();
    };
    const onWheel = (): void => { if (!wheels || wheels.begins()) cancel(); };
    window.addEventListener("keydown", onKey);
    canvas?.addEventListener("pointerdown", onPress);
    canvas?.addEventListener("wheel", onWheel, { passive: true });
    return {
      stop() {
        window.removeEventListener("keydown", onKey);
        canvas?.removeEventListener("pointerdown", onPress);
        canvas?.removeEventListener("wheel", onWheel);
      },
      press: () => held,
    };
  }

  const vec3Zero: Vec3 = [0, 0, 0];
  const glideKeepPerFrame = (): number => runtime.getCameraHandling?.().glideKeepPerFrame ?? DEFAULT_INERTIA_DECAY_PER_FRAME;

  /**
   * Gives the globe camera back from a flight cut short, where the flight got
   * to: moving on as it was, for the globe's glide to slow, when the person
   * cut it short (`moving`), or at rest when another navigation takes over.
   * Input begun during the flight goes on moving the camera, a mouse `press`
   * as a drag. Without a runtime that takes the camera back moving, it
   * returns to the overview. The lease stays the caller's to release.
   */
  function handBack(lease: NavigationLease, flying: Flying, moving: boolean, press: HeldPress | null): void {
    const { flight, marker, t } = flying;
    const s = smooth(t);
    const pose = flight.pose(s);
    // The eased progress's rate, per second, at the last frame drawn.
    let { velocity, turn } = moving ? flightMotion(flight, s, (6 * t * (1 - t) * 1000) / flying.durationMs) : { velocity: vec3Zero, turn: vec3Zero };
    // Into the orb, a glide stops short of its sphere: the rest of the way is the flight's, not the map's.
    const toMarker = sub(marker, pose.position);
    const gap = length(toMarker) - flight.radiusMeters;
    const inward = dot(velocity, toMarker) / Math.max(1e-9, length(toMarker));
    const keep = glideKeepPerFrame();
    // A 60 Hz frame's step, summed as the glide slows.
    const travel = keep < 1 ? (inward / 60) / (1 - keep) : Number.POSITIVE_INFINITY;
    if (travel > 0 && travel > Math.max(0, gap)) {
      const share = Math.max(0, gap) / travel;
      velocity = scale(velocity, share);
      turn = scale(turn, share);
    }
    const handed = runtime.glideNavigationCamera?.(lease, presented(pose), ecef(marker), {
      velocity: ecef(velocity), turn: ecef(turn), fovRad: lease.overview.camera.fov, inputSince: flying.startedMs, press,
    }) ?? false;
    if (!handed) runtime.restoreNavigationSnapshot(lease.overview, lease);
  }

  /** An orb's sphere turning back into the orb after a flight cut short, and what ends with it. */
  let fading: { controller: AbortController; finish(): void } | null = null;

  /**
   * Turns a flight's sphere back into its orb as the camera's glide slows,
   * on the glide's curve: to the orb's own size from where the camera is,
   * its overlay fading. `done` runs once it is over, or stopped.
   */
  function fadeSphere(entry: Entry, flying: Flying, done: () => void): void {
    stopFade();
    const { flight } = flying;
    const revealed = flying.reveal(smooth(flying.t));
    const curve = glideSettling(glideKeepPerFrame());
    const controller = new AbortController();
    const mounted = (): boolean => entries.get(entry.record.id) === entry;
    // The orb stays where the sphere is drawn about until it is itself again.
    entry.placement.frozen = true;
    let finished = false;
    const current = {
      controller,
      finish() {
        if (finished) return;
        finished = true;
        if (fading === current) fading = null;
        if (mounted()) {
          entry.orb.setExpansion(null);
          entry.placement.frozen = false;
        }
        done();
      },
    };
    fading = current;
    void animate(curve.durationMs, u => {
      if (!mounted()) return;
      const settled = curve.settled(u * curve.durationMs);
      const own = entry.orb.effectiveRadius() ?? flight.radiusMeters;
      entry.orb.setExpansion({
        radiusMeters: flight.radiusMeters + (own - flight.radiusMeters) * settled,
        reveal: revealed * (1 - settled),
        ...(flying.source ? { source: flying.source } : {}),
      });
    }, controller.signal, null).then(() => current.finish(), () => current.finish());
  }

  /** Ends a sphere's fade at once, for whatever needs its orb next. */
  function stopFade(): void {
    const current = fading;
    if (!current) return;
    current.controller.abort();
    current.finish();
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
      if (immersion === state && !state.leaving && state.roll !== 0) {
        state.roll = 0;
        state.look.set(state.look.get());
      }
    } finally {
      if (arrival === controller) arrival = null;
    }
  }

  /** The image detail as a width cap in px around the turn: infinite at its largest, where only the device limits. */
  function detailCap(): number {
    const state = settings.inspect("scene.panorama.immersionWidth");
    if (typeof state.value !== "number") return Number.POSITIVE_INFINITY;
    return state.bounds && state.value >= state.bounds.max ? Number.POSITIVE_INFINITY : state.value;
  }
  const mebibytes = (bytes: number) => `${(bytes / MIB).toFixed(bytes >= 10 * MIB ? 0 : 1)} MiB`;

  /** Why `rep` does not fit the GPU budgets now, in words. */
  function memoryRefusal(rep: ResolvedRepresentation): string {
    const bytes = representationGpuBytes(rep, num("scene.panorama.tileMemoryMiB") * MIB, deviceMaxSide());
    const pools = resources.stats().pools;
    if (bytes > pools.overlap.limit - pools.overlap.reserved) {
      return `${imageName(rep)} needs ${mebibytes(bytes)} of GPU memory with its mips, more than the ${mebibytes(pools.overlap.limit)} replacement overlap allows (Scenes → Loading and memory).`;
    }
    return `${imageName(rep)} needs ${mebibytes(bytes)} of GPU memory with its mips; ${mebibytes(Math.max(0, resources.gpuRoom()))} of the ${mebibytes(pools.sourceGpu.limit)} panorama GPU memory is free (Scenes → Loading and memory).`;
  }

  /**
   * Chooses the image to show and, when it is not the one on screen, loads it
   * in the background and puts it on screen. A tiled cube, when the
   * representation asks for one and the panorama offers it, shows over the
   * preview at once and sharpens as its tiles arrive. Otherwise the largest
   * whole image the panorama offers within the image detail, the device and
   * the budgets, or with a sharpness target the smallest that meets it,
   * crossfades in once loaded. Either way the status says which image is
   * shown and why no larger one is.
   */
  function refine(state: Immersion): void {
    const tiles = renderer.available ? preferredTiles(state) : { representation: null, note: null };
    if (tiles.representation) {
      const refusal = tilesRefusal(state, tiles.representation);
      if (!refusal) { refineTiles(state, tiles.representation, tiles.note); return; }
      refineWhole(state, refusal);
      return;
    }
    refineWhole(state, tiles.note);
  }

  /** Why a tiled cube cannot be shown now, or null. */
  function tilesRefusal(state: Immersion, representation: ResolvedTiledCube): string | null {
    const shown = state.shown.handle;
    if (shown.representation.id === representation.id && shown.texture.tiles?.panorama.layout.slots === tileAtlasLayout(representation, num("scene.panorama.tileMemoryMiB") * MIB, deviceMaxSide())?.slots) return null;
    const layout = tileAtlasLayout(representation, num("scene.panorama.tileMemoryMiB") * MIB, deviceMaxSide());
    if (!layout) return `Not one tile fits the tile memory, so it shows a whole image (Scenes → Tiled images).`;
    if (resources.wouldFit(representation, true)) return null;
    const pools = resources.stats().pools;
    return `Its ${tilesName(representation.warp)} need ${mebibytes(layout.gpuBytes)} of GPU memory for their tiles; ${mebibytes(Math.max(0, Math.min(resources.gpuRoom(), pools.overlap.limit - pools.overlap.reserved)))} is free (Scenes → Loading and memory), so it shows a whole image.`;
  }

  function refineTiles(state: Immersion, representation: ResolvedTiledCube, note: string | null): void {
    const entry = state.shown.entry;
    const shown = state.shown.handle;
    if (shown.representation.id === representation.id && shown.texture.tiles?.panorama.layout.slots === tileAtlasLayout(representation, num("scene.panorama.tileMemoryMiB") * MIB, deviceMaxSide())?.slots) {
      state.refine?.abort();
      state.refine = null;
      dropIncoming(state);
      state.detail = { representation: representation.id, limitation: note, loading: null };
      emit();
      return;
    }
    // Already on its way: let it arrive.
    if (state.refine && !state.refine.signal.aborted && state.detail.loading === representation.id) return;
    state.refine?.abort();
    dropIncoming(state);
    const controller = new AbortController();
    state.refine = controller;
    state.detail = { representation: shown.representation.id, limitation: null, loading: representation.id };
    emit();
    resources.acquire(entry.asset, representation, { signal: controller.signal, priority: 5, overlap: true, ...(entry.preview.handle ? { fallback: entry.preview.handle.representation } : {}) }).then(async handle => {
      if (immersion !== state || controller.signal.aborted || state.shown.entry !== entry) { handle.release(); return; }
      // A cached atlas comes back with the settings of its last use.
      if (handle.texture.tiles) {
        handle.texture.tiles.panorama.setLimits(tileLimits());
        handle.texture.tiles.textures.outlines = settings.get("scene.panorama.tileOutlines") === true;
      }
      const previous = state.shown.handle;
      // Over the preview the tiles show at once: where none has arrived, they draw the same preview.
      if (previous.representation.role !== "preview") {
        // Over a sharper image, the view's tiles load behind it first, then crossfade in.
        state.incoming = { handle, entry };
        const fade = reducedMotion() ? num("scene.panorama.reducedFadeDuration") : num("scene.panorama.fadeDuration");
        try {
          await tilesCoverView(handle, controller.signal);
          await animate(fade, t => {
            if (immersion === state) renderer.immersion.show({ source: sourceOf(entry, previous), next: sourceOf(entry, handle), mix: smooth(t) });
          }, controller.signal, state.lease);
        } catch {
          if (state.incoming?.handle === handle) state.incoming = null;
          handle.release();
          return;
        }
        if (state.incoming?.handle === handle) state.incoming = null;
      }
      if (immersion !== state) { handle.release(); return; }
      renderer.immersion.show({ source: sourceOf(entry, handle) });
      state.shown = { handle, entry };
      state.detail = { representation: representation.id, limitation: note, loading: null };
      if (state.refine === controller) state.refine = null;
      // The preview stays cached for the orb; only the reference is dropped.
      if (previous !== entry.preview.handle) previous.release();
      runtime.requestRender();
      emit();
    }, error => {
      if (immersion !== state || controller.signal.aborted) return;
      if (state.refine === controller) state.refine = null;
      const cause = error instanceof Error ? error.message : String(error);
      state.failedTiles.add(representation.id);
      report("image", entry, cause, `${entry.record.title}: its ${tilesName(representation.warp)} could not be shown, so it shows a whole image: ${sentence(cause)}`);
      refine(state);
    });
  }

  /** The whole images' choice; `note` says why no tiled cube is shown, when one was asked for. */
  function refineWhole(state: Immersion, note: string | null): void {
    const entry = state.shown.entry;
    const shownId = state.shown.handle.representation.id;
    const previewId = entry.preview.handle?.representation.id ?? null;
    const cap = detailCap();
    const target = settings.get("scene.panorama.immersionDensity");
    const frame = typeof target === "number" ? renderer.cameraFrame(runtime.getPresentationView()) : null;
    // Off, or without a frame to measure: the largest the detail allows.
    const wanted = typeof target === "number" && frame
      ? immersionFaceTexels(frame.viewportHeightCssPx * devicePixelsPerCss(), state.look.get().verticalFovDeg * DEG_TO_RAD, target)
      : Number.POSITIVE_INFINITY;
    const deviceSide = deviceMaxSide();
    // The orb's preview is on the GPU already and can always be shown; the image on screen, within the detail. Tiles are not whole images.
    const candidates = entry.asset.representations.filter(rep => rep.projection !== "tiled-cube" && (rep.role === "immersion" || rep.id === shownId || rep.id === previewId));
    const choice = chooseRepresentation(candidates, "any", wanted, rep => {
      if (rep.id === previewId) return null;
      if (representationAroundPx(rep) > cap) return `${imageName(rep)} is more than the ${Math.round(cap)} px image detail allows.`;
      if (rep.id === shownId) return null;
      if (representationMaxSide(rep) > deviceSide) return `${imageName(rep)} is ${representationMaxSide(rep)} px on a side; this renderer's largest texture is ${deviceSide} px.`;
      return resources.wouldFit(rep, true) ? null : memoryRefusal(rep);
    });
    if (!choice) return;
    const chosen = choice.representation;
    const largest = Math.max(...candidates.map(representationAroundPx));
    const limitation = [note, choice.next?.reason
      ?? (representationAroundPx(chosen) < largest && typeof target === "number"
        ? `The sharpness target is met: ${Math.round(wanted)} texels per cube face, ${target} per rendered pixel (360 image settings → Image).`
        : null)].filter(Boolean).join(" ") || null;
    // Already on its way: let it arrive.
    if (state.refine && !state.refine.signal.aborted && state.detail.loading === chosen.id) return;
    state.refine?.abort();
    state.refine = null;
    dropIncoming(state);
    if (chosen.id === shownId) {
      state.detail = { representation: shownId, limitation, loading: null };
      emit();
      return;
    }
    const controller = new AbortController();
    state.refine = controller;
    state.detail = { representation: shownId, limitation: null, loading: chosen.id };
    emit();
    resources.acquire(entry.asset, chosen, { signal: controller.signal, priority: 5, overlap: true }).then(async handle => {
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
      state.detail = { representation: handle.representation.id, limitation, loading: null };
      if (state.refine === controller) state.refine = null;
      // The preview stays cached for the orb; only the reference is dropped.
      if (previous !== entry.preview.handle) previous.release();
      emit();
    }, error => {
      if (immersion !== state || controller.signal.aborted) return;
      if (state.refine === controller) state.refine = null;
      const cause = error instanceof Error ? error.message : String(error);
      const failed = `${imageName(chosen)} could not be loaded: ${sentence(cause)}`;
      state.detail = { representation: state.shown.handle.representation.id, limitation: failed, loading: null };
      const shown = imageName(state.shown.handle.representation).toLowerCase();
      report("image", entry, cause, `${entry.record.title}: ${imageName(chosen).toLowerCase()} could not be loaded, so ${shown} stays on screen: ${sentence(cause)}`);
      emit();
    });
  }

  /** Stops everything that moves the view: looking, levelling, and a sharper image's crossfade. */
  function silence(state: Immersion): void {
    arrival?.abort();
    arrival = null;
    state.refine?.abort();
    state.input.detach();
    state.stopLook();
    state.offIntents();
  }

  /** Ends immersion. With `keepShown`, the image on screen stays loaded, and is returned for the caller to release. */
  function teardownImmersion(reason: "exit" | "lease" | "dispose", keepShown = false): SourceHandle<PanoramaGpuTexture> | null {
    const state = immersion;
    if (!state) return null;
    immersion = null;
    silence(state);
    dropIncoming(state);
    state.offLeaseAbort();
    renderer.immersion.show(null);
    const own = state.shown.handle !== state.shown.entry.preview.handle ? state.shown.handle : null;
    if (own && !keepShown) own.release();
    for (const entry of entries.values()) entry.placement.frozen = false;
    if (reason === "lease") {
      // The lease is gone, so the globe camera is free: return to the overview it was entered from.
      runtime.restoreNavigationSnapshot(state.lease.overview);
      phase = "overview";
      target = null;
      navigationError("Navigation ended: the renderer lost its device or was torn down.");
    }
    emit();
    return keepShown ? own : null;
  }

  async function enter(id: string, enterOptions: EnterOptions = {}): Promise<SceneActionResult> {
    if (disposed) return { ok: false, reason: "disposed", message: "The scene has been disposed." };
    const entry = entries.get(id);
    if (!entry) return { ok: false, reason: "unavailable", message: current.unsupported.get(id)?.reason ?? `No panorama ${id} in this scene.` };
    if (!renderer.available) return { ok: false, reason: "unavailable", message: renderer.unavailableReason ?? "Panoramas cannot be drawn here." };
    if (exiting) {
      // Entering cuts an exit short: it stops where it got to, then this entry begins from there.
      operation?.abort(giveWay("Replaced by another navigation."));
      await exiting;
      if (disposed) return { ok: false, reason: "disposed", message: "The scene has been disposed." };
    }
    stopFade();
    if (immersion) return navigateWithin(entry, enterOptions.view, enterOptions.signal, "push");
    const op = beginOperation(enterOptions.signal);
    const { signal } = op;
    phase = "preparing";
    target = id;
    lastError = null;
    emit();
    let lease: NavigationLease | null = null;
    // The flight under way, for a cut to carry on from where it got to.
    let flying: Flying | null = null;
    const input = cancelOnInput(op);
    const stopCancelling = input.stop;
    // The runtime ending the lease (device loss, teardown) ends the entry too.
    const endWithLease = (): void => op.abort(new DOMException("Navigation ended.", "AbortError"));
    try {
      const first = await ensurePreview(entry, signal);
      if (signal.aborted) throw signal.reason;
      // The orb's preview as it is when it is drawn: a sharper one may take its place during the entry.
      const shownPreview = (): SourceHandle<PanoramaGpuTexture> => entry.preview.handle ?? first;
      // Not ended by the entry's signal: a flight cut short keeps the lease while it coasts. Every way out releases it.
      const acquired = runtime.acquireNavigation({ owner: "foss-earth.scenes", inputContext: "panorama", terrain: "paused" });
      if (!acquired.ok) {
        phase = "overview";
        target = null;
        emit();
        return { ok: false, reason: acquired.reason === "aborted" ? "cancelled" : "busy", message: acquired.message };
      }
      lease = acquired.lease;
      lease.signal.addEventListener("abort", endWithLease, { once: true });
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
      const marker = entry.placement.marker;
      const betaR = previewHalfAngle();
      const held = acquired.lease;
      const flightMs = marker && entry.placement.state === "placed" ? flightDuration() : 0;
      const flight = marker && flightMs > 0
        ? flightIn({ position: frame.eye, forward: frame.view.forward, up: frame.view.up, verticalFovRad: frame.view.verticalFovRad }, marker, entry.orb.effectiveRadius(frame) ?? entry.record.marker.radiusMeters ?? 1)
        : null;
      const expansion = !flight && marker && entry.placement.state === "placed" && !reducedMotion()
        ? (() => {
          const rel = sub(marker, frame.eye);
          const distance = length(rel);
          const startRadius = entry.orb.effectiveRadius(frame) ?? entry.record.marker.radiusMeters ?? 1;
          if (distance <= startRadius) return null;
          const radius = expansionTargetRadius(distance, scale(rel, 1 / distance), frame.view, betaR);
          return radius === null ? null : { rel, distance, startRadius, radius };
        })()
        : null;
      // The view the panorama settles on, known before the camera moves: its tiles load from here.
      const openingOn = (arriving: GeoView): GeoView => arrivalFor(entry, arriving, enterOptions.view);
      if (flight && marker) {
        const landing = flight.pose(1);
        warmTiles(entry, openingOn(viewFromPresentation(entry.frame, { position: ecef(landing.position), forward: ecef(landing.forward), up: ecef(landing.up), verticalFovRad: landing.verticalFovRad })));
        // Fly the globe camera into the orb, a sphere of its size on screen when the flight began, until it is inside it.
        const underway: Flying = { flight, marker, durationMs: flightMs, startedMs: now(), t: 0, reveal: s => s };
        flying = underway;
        await animate(flightMs, t => {
          underway.t = t;
          const eased = smooth(t);
          placeCamera(held, flight.pose(eased));
          entry.orb.setExpansion({ radiusMeters: flight.radiusMeters, reveal: eased });
        }, signal, held);
        flying = null;
        const end = flight.pose(1);
        if (!handoffReady(orbGeometry(sub(marker, end.position), flight.radiusMeters), poseView(end, frame.view.aspect), betaR)) throw new Error("The flight did not end inside the orb; this is a defect.");
        // Handoff: inside the sphere every ray shows the image itself, so the fullscreen image equals the orb's last frame.
        incoming = viewFromPresentation(entry.frame, { position: ecef(end.position), forward: ecef(end.forward), up: ecef(end.up), verticalFovRad: end.verticalFovRad });
        renderer.immersion.show({ source: sourceOf(entry, shownPreview()) });
        lease.setPresentationView(presentation(entry, incoming));
        entry.orb.setExpansion(null);
      } else if (expansion) {
        warmTiles(entry, openingOn(incoming));
        // Grow a virtual sphere about the fixed marker until it covers the view and its rays equal the view's.
        await animate(num("scene.panorama.expandDuration"), t => {
          const eased = smooth(t);
          entry.orb.setExpansion({ radiusMeters: expansion.startRadius + (expansion.radius - expansion.startRadius) * eased, reveal: eased });
        }, signal, lease);
        if (!handoffReady(orbGeometry(expansion.rel, expansion.radius), frame.view, betaR)) throw new Error("The expanded orb did not cover the view; this is a defect.");
        // Handoff: identical rays, so the fullscreen image equals the orb's last frame.
        renderer.immersion.show({ source: sourceOf(entry, shownPreview()) });
        lease.setPresentationView(presentation(entry, incoming));
        entry.orb.setExpansion(null);
      } else {
        // No continuous reveal from here (behind, inside, off screen or reduced motion): fade in the arrival view.
        const view = arrivalFor(entry, incoming, enterOptions.view);
        const target = presentation(entry, view);
        warmTiles(entry, view);
        const fade = reducedMotion() ? num("scene.panorama.reducedFadeDuration") : num("scene.panorama.fadeDuration");
        await animate(fade, t => renderer.immersion.show({ source: sourceOf(entry, shownPreview()), opacity: smooth(t), view: target }), signal, lease);
        renderer.immersion.show({ source: sourceOf(entry, shownPreview()) });
        lease.setPresentationView(target);
        incoming = view;
      }
      stopCancelling();
      const handle = shownPreview();
      const state = startImmersion(lease, entry, handle, incoming, { representation: handle.representation.id, limitation: entry.preview.limitation, loading: null });
      immersion = state;
      phase = "immersive";
      resetHover();
      target = null;
      if (history) {
        if (!historyStarted) { recordHistoryOverview(); historyStarted = true; }
        recordHistory("push");
      }
      emit();
      refine(state);
      // The panorama now waits on the same atlas, so the warming's hold on it can go.
      stopWarming(entry);
      void arrive(state, arrivalFor(entry, incoming, enterOptions.view));
      return { ok: true };
    } catch (error) {
      stopCancelling();
      // Another navigation or a new scene now owns the phase.
      const replaced = gaveWay(signal);
      let fadingSphere = false;
      if (lease && !immersion) {
        const held = lease;
        renderer.immersion.show(null);
        if (flying && !disposed && !held.released) {
          // The camera stays where the flight got to, not back at the start: moving on as it was when the person cut it short.
          handBack(held, flying, !replaced, input.press());
          if (!replaced) {
            fadeSphere(entry, flying, () => {});
            fadingSphere = true;
          }
        } else runtime.restoreNavigationSnapshot(held.overview, held);
        held.release("cancelled");
      }
      if (!fadingSphere) {
        entry.orb.setExpansion(null);
        entry.placement.frozen = false;
      }
      if (!immersion && !replaced && !disposed) { phase = "overview"; target = null; }
      const result = failure(error, signal, entry, `${entry.record.title} could not be entered`);
      emit();
      return result;
    } finally {
      stopCancelling();
      stopWarming(entry);
      lease?.signal.removeEventListener("abort", endWithLease);
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
      const first = await ensurePreview(entry, signal);
      if (immersion !== state) throw new DOMException("Immersion ended.", "AbortError");
      // As on entering from the map: the destination's preview as it is when it is drawn.
      const shownPreview = (): SourceHandle<PanoramaGpuTexture> => entry.preview.handle ?? first;
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
        renderer.immersion.show({ source: sourceOf(from.entry, from.handle), next: sourceOf(entry, shownPreview()), mix: smooth(t), view: t < 0.5 ? fromView : toView });
      }, signal, state.lease);
      if (immersion !== state) throw new DOMException("Immersion ended.", "AbortError");
      state.refine?.abort();
      dropIncoming(state);
      state.failedTiles.clear();
      if (from.handle !== from.entry.preview.handle) from.handle.release();
      const handle = shownPreview();
      state.shown = { handle, entry };
      state.id = entry.record.id;
      state.detail = { representation: handle.representation.id, limitation: entry.preview.limitation, loading: null };
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
      const result = failure(error, signal, entry, `${entry.record.title} could not be entered`);
      emit();
      return result;
    } finally {
      if (operation === op) operation = null;
    }
  }

  async function follow(linkId: string, followOptions: { signal?: AbortSignal } = {}): Promise<SceneActionResult> {
    if (disposed) return { ok: false, reason: "disposed", message: "The scene has been disposed." };
    const state = immersion;
    if (!state || state.leaving) return { ok: false, reason: "unavailable", message: "Links are followed from inside a panorama." };
    const link = state.shown.entry.record.links.find(each => each.id === linkId);
    if (!link) return { ok: false, reason: "unavailable", message: `No link ${linkId} here.` };
    const destination = entries.get(link.target);
    if (!destination) return { ok: false, reason: "unavailable", message: `${link.label} leads to something this loader does not show.` };
    return navigateWithin(destination, link.arrivalView, followOptions.signal, "push");
  }

  /** The exit under way, which a second exit joins rather than repeats. */
  let exiting: Promise<SceneActionResult> | null = null;

  function exitTo(historyMode: "push" | "none"): Promise<SceneActionResult> {
    if (disposed) return Promise.resolve({ ok: false, reason: "disposed", message: "The scene has been disposed." });
    if (exiting) return exiting;
    if (!immersion) {
      // Escape during preparation or entry cancels it.
      operation?.abort(new DOMException("Cancelled.", "AbortError"));
      return Promise.resolve({ ok: true });
    }
    const run = leave(immersion, historyMode).finally(() => { if (exiting === run) exiting = null; });
    exiting = run;
    return run;
  }

  /**
   * The flight out of the panorama on screen: from inside its orb's sphere,
   * which shows the image on screen with the view's own rays, to the view
   * that keeps the heading and looks back at the orb with the overview's
   * pitch, distance and field of view. Null when the flight is off, the orb
   * has no place, or the handoff would not be exact: then the image fades.
   */
  function exitFlight(state: Immersion, view: NavigationPresentation): (Flight & { end: NavigationSnapshot; ms: number }) | null {
    const ms = flightDuration();
    const entry = state.shown.entry;
    const marker = entry.placement.marker;
    const frame = renderer.cameraFrame(view);
    if (!(ms > 0) || !marker || entry.placement.state !== "placed" || !frame) return null;
    const overview = state.lease.overview.camera;
    // The orb's own size on screen where the flight ends, so the sphere becomes the orb there.
    const radius = effectiveOrbRadius(
      entry.record.marker.radiusMeters ?? num("scene.panorama.markerRadiusMeters"), overview.radius,
      { view: { ...frame.view, verticalFovRad: overview.fov }, viewportHeightCssPx: frame.viewportHeightCssPx }, range("scene.panorama.markerDiameter"),
    );
    const flight = flightOut({ forward: vec3(view.forward), up: vec3(view.up), verticalFovRad: view.verticalFovRad }, marker, radius, overview);
    if (!flight) return null;
    const start = flight.pose(0);
    if (!handoffReady(orbGeometry(sub(marker, start.position), radius), poseView(start, frame.view.aspect), previewHalfAngle())) return null;
    return { ...flight, ms };
  }

  async function leave(state: Immersion, historyMode: "push" | "none"): Promise<SceneActionResult> {
    const op = beginOperation();
    phase = "exiting";
    state.leaving = true;
    silence(state);
    emit();
    const entry = state.shown.entry;
    const view = presentation(entry, geoView(state.look.get(), state.roll));
    const source = sourceOf(entry, state.shown.handle);
    const flight = exitFlight(state, view);
    const flying: Flying | null = flight && entry.placement.marker
      ? { flight, marker: entry.placement.marker, durationMs: flight.ms, startedMs: now(), t: 0, reveal: s => 1 - s, source }
      : null;
    // As during entry, Escape, a press or a new wheel gesture cut the animation short; so does the runtime ending the lease.
    const input = cancelOnInput(op);
    const stopCancelling = input.stop;
    const endWithLease = (): void => op.abort(new DOMException("Navigation ended.", "AbortError"));
    state.lease.signal.addEventListener("abort", endWithLease, { once: true });
    let cut = false;
    try {
      if (flight && flying) {
        // Handoff: inside the sphere the orb shows the image on screen with the view's own rays, so its first frame equals the image's last.
        placeCamera(state.lease, flight.pose(0));
        entry.orb.setExpansion({ radiusMeters: flight.radiusMeters, reveal: 1, source });
        state.lease.setPresentationView(null);
        renderer.immersion.show(null);
        await animate(flight.ms, t => {
          flying.t = t;
          const eased = smooth(t);
          placeCamera(state.lease, flight.pose(eased));
          entry.orb.setExpansion({ radiusMeters: flight.radiusMeters, reveal: 1 - eased, source });
        }, op.signal, state.lease);
      } else {
        // Back to the saved overview first, then the image fades off it.
        runtime.restoreNavigationSnapshot(state.lease.overview, state.lease);
        state.lease.setPresentationView(null);
        const fade = reducedMotion() ? num("scene.panorama.reducedFadeDuration") : num("scene.panorama.fadeDuration");
        await animate(fade, t => renderer.immersion.show({ source, opacity: 1 - smooth(t), view }), op.signal, state.lease);
      }
    } catch {
      // Cut short: a fade completes at once; a flight stops where it got to.
      cut = true;
    } finally {
      stopCancelling();
      state.lease.signal.removeEventListener("abort", endWithLease);
    }
    // Cut short by the person, the camera stays where the flight got to, moving on as it was; replaced by an entry, at rest there.
    const handedBack = Boolean(flying && cut && immersion === state && !disposed && !state.lease.released);
    if (flying && handedBack) handBack(state.lease, flying, !gaveWay(op.signal), input.press());
    else {
      if (flying && entries.get(entry.record.id) === entry) entry.orb.setExpansion(null);
      if (flight && immersion === state) runtime.restoreNavigationSnapshot(flight.end, state.lease);
    }
    if (operation === op) operation = null;
    // Replaced, disposed or ended by the runtime meanwhile, which put the camera back itself.
    if (immersion !== state) return { ok: true };
    const focus = state.lease.focusReturn;
    // The sphere draws the image on screen until it has turned back into the orb.
    const shown = teardownImmersion("exit", handedBack);
    state.lease.release("exit");
    if (flying && handedBack) fadeSphere(entry, flying, () => shown?.release());
    phase = "overview";
    target = null;
    if (historyMode === "push") recordHistory("push");
    if (focus instanceof HTMLElement && focus.isConnected) focus.focus();
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
        navigationError("That history entry belongs to another revision of this scene.");
        if (immersion) void exitTo("none");
        emit();
        return;
      }
      if (entry.destination === null) {
        if (immersion) void exitTo("none");
        return;
      }
      const destination = entries.get(entry.destination);
      if (!destination) { navigationError(`${entry.destination} is no longer in this scene.`); emit(); return; }
      const view = entry.view ? { headingDeg: entry.view.headingDeg, pitchDeg: entry.view.pitchDeg, verticalFovDeg: entry.view.verticalFovDeg } : undefined;
      if (immersion && !exiting) void navigateWithin(destination, view, undefined, "none");
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
    stopWarming();
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
  const loadingIds = ["sourceGpuMiB", "overlapMiB", "keptGpuMiB", "decodedMiB", "encodedMiB", "responseMiB", "requests", "decodes", "requestTimeout", "immersionWidth", "tileMemoryMiB", "previewSheets"].map(id => `scene.panorama.${id}`);
  for (const id of loadingIds) cleanups.push(settings.watch(id, () => resources.setSettings(resourceSettingsFrom(each => settings.get(each), detailCap()))));
  // The image detail, the sharpness target and the GPU budgets choose the image on screen again at once.
  for (const id of ["scene.panorama.immersionWidth", "scene.panorama.immersionDensity", "scene.panorama.sourceGpuMiB", "scene.panorama.overlapMiB", "scene.panorama.representation", "scene.panorama.tileMemoryMiB"]) {
    cleanups.push(settings.watch(id, () => {
      if (!immersion) return;
      // Asked for again: a tiled cube that failed may load now.
      if (id === "scene.panorama.representation") immersion.failedTiles.clear();
      if (phase === "immersive") refine(immersion);
      runtime.requestRender();
    }));
  }
  const tileLimitIds = ["tileRequests", "tilesWaiting", "tileDecodes", "tileUploadsPerFrame", "tileRetries", "tileRetryDelay", "fadeDuration", "reducedFadeDuration", "reducedMotion", "requestTimeout", "responseMiB"].map(id => `scene.panorama.${id}`);
  for (const id of tileLimitIds) {
    cleanups.push(settings.watch(id, () => {
      if (immersion) for (const { handle } of liveTiles(immersion)) handle.texture.tiles!.panorama.setLimits(tileLimits());
    }));
  }
  for (const id of ["scene.panorama.tileMarginDeg", "scene.panorama.tileOutlines"]) {
    cleanups.push(settings.watch(id, () => {
      if (!immersion) return;
      for (const { handle } of liveTiles(immersion)) handle.texture.tiles!.textures.outlines = settings.get("scene.panorama.tileOutlines") === true;
      runtime.requestRender();
    }));
  }
  for (const id of ["scene.panorama.uploadMiBPerFrame", "scene.panorama.uploadOutstandingMiB"]) cleanups.push(settings.watch(id, () => uploader?.setLimits(uploadLimits())));
  for (const id of ["scene.panorama.previewFov", "scene.panorama.markerDiameter", "scene.panorama.hitTargetDiameter"]) cleanups.push(settings.watch(id, applyAppearance));
  for (const id of Object.values(experimentIds)) {
    if (settings.has(id)) cleanups.push(settings.watch(id, () => setRendererExperiments?.(panoramaExperiments())));
  }
  cleanups.push(settings.watch("scene.panorama.markerRadiusMeters", () => {
    for (const entry of entries.values()) if (entry.record.marker.radiusMeters === undefined) entry.orb.update({ radiusMeters: num("scene.panorama.markerRadiusMeters") });
    emit();
  }));
  const readings: [string, () => string | null][] = [
    ["scene.panorama.immersionWidth", () => {
      const shown = immersion?.shown.handle;
      if (!shown) return null;
      const tiles = shown.texture.tiles?.panorama;
      // Tiles show the level the view needs, which may be below their finest.
      if (tiles) return `${4 * tiles.representation.tileSize * 2 ** tiles.stats().levelWanted} px around in the view, from tiles at level ${tiles.stats().levelWanted}`;
      return `${representationAroundPx(shown.representation)} px on screen`;
    }],
    ["scene.panorama.sourceGpuMiB", () => { const p = resources.stats().pools.sourceGpu; return `${mebibytes(p.reserved)} reserved, ${mebibytes(p.peak)} at most so far`; }],
    ["scene.panorama.overlapMiB", () => `${mebibytes(resources.stats().pools.overlap.reserved)} of replacement coexisting`],
    ["scene.panorama.keptGpuMiB", () => { const s = resources.stats(); return `${mebibytes(s.keptBytes)} kept for ${s.keptSources} ${s.keptSources === 1 ? "image" : "images"} not on screen`; }],
    ["scene.panorama.decodedMiB", () => `${mebibytes(resources.stats().pools.decoded.reserved)} decoded and waiting to upload`],
    ["scene.panorama.encodedMiB", () => `${mebibytes(resources.stats().pools.encoded.reserved)} downloaded or arriving`],
    ["scene.panorama.responseMiB", () => { const s = resources.stats(); return `largest so far ${mebibytes(s.largestResponseBytes)}${s.rejectedResponses ? `, ${s.rejectedResponses} refused` : ""}`; }],
    ["scene.panorama.requests", () => { const s = resources.stats(); return `${s.activeRequests} active, ${s.queuedRequests} queued`; }],
    ["scene.panorama.decodes", () => { const s = resources.stats(); return `${s.activeDecodes} active, ${s.queuedDecodes} queued`; }],
    ["scene.panorama.uploadMiBPerFrame", () => (uploader ? `${mebibytes(uploader.stats().lastFrameBytes)} in the last frame` : null)],
    ["scene.panorama.uploadOutstandingMiB", () => (uploader ? `${mebibytes(uploader.stats().outstandingBytes)} submitted, not yet done` : null)],
    ["scene.panorama.tileMemoryMiB", () => {
      const stats = immersion?.shown.handle.texture.tiles?.panorama.stats();
      return stats ? `${stats.resident} of ${stats.slots} tiles held` : null;
    }],
    ["scene.panorama.tileRequests", () => {
      const stats = immersion?.shown.handle.texture.tiles?.panorama.stats();
      return stats ? `${stats.loading} loading, ${stats.requests} asked for in this panorama` : null;
    }],
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
      const candidate = await resolveInput(input, settings, replaceOptions.baseUrl ?? current.baseUrl ?? undefined, replaceOptions.signal, options.onProgress);
      if (!candidate.ok) return candidate;
      if (disposed) return { ok: false, errors: [{ path: "$", message: "The scene has been disposed." }] };
      if (replaceOptions.signal?.aborted) return { ok: false, errors: [{ path: "$", message: "Loading was cancelled." }] };
      // Validated: now swap. Removing the active scene ends navigation at a valid overview.
      stopFade();
      operation?.abort(giveWay("The scene was replaced."));
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
      overviewPreparation?.abort();
      const controller = new AbortController();
      overviewPreparation = controller;
      const signal = overviewOptions.signal ? AbortSignal.any([controller.signal, overviewOptions.signal]) : controller.signal;
      const loadingGeneration = generation;
      const onAbort = (): void => {
        if (overviewPreparation === controller) cancelPendingOverview();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        signal.removeEventListener("abort", onAbort);
        return { ok: false, reason: "cancelled", message: "Cancelled." };
      }
      let ground = overview.target.height?.meters ?? runtime.surface.sample(overview.target.latitudeDeg, overview.target.longitudeDeg)?.heightMeters ?? null;
      if (ground === null) {
        overviewState = "pending";
        emit();
        try {
          const preparing = runtime.prepareTerrain({
            latDeg: overview.target.latitudeDeg, lonDeg: overview.target.longitudeDeg,
            radiusMeters: Math.max(overview.distanceMeters * 2, 200), altitudeAboveGroundMeters: 0, clearanceMeters: 0,
            signal,
          });
          // Preparation establishes its destination synchronously. Changes
          // after that belong to the person or host, including a controller.
          overviewPreparedView = runtime.captureNavigationSnapshot()?.view ?? null;
          const prepared = await preparing;
          ground = prepared.groundHeightMeters;
        } catch (error) {
          signal.removeEventListener("abort", onAbort);
          if (overviewPreparation === controller) overviewPreparation = null;
          const result = failure(error, signal, null, "The scene's overview could not be shown");
          if (!result.ok && result.reason === "failed") emit();
          return result;
        }
      }
      signal.removeEventListener("abort", onAbort);
      if (disposed || loadingGeneration !== generation || signal.aborted) return { ok: false, reason: "cancelled", message: "Cancelled." };
      if (overviewCameraMoved()) cancelPendingOverview();
      if (signal.aborted) return { ok: false, reason: "cancelled", message: "Cancelled." };
      overviewPreparation = null;
      overviewPreparedView = null;
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
    hover(id) {
      if (!disposed) setHovered(id);
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
      stopFade();
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
