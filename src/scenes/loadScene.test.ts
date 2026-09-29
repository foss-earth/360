// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BaseTexture } from "@babylonjs/core";
import { createNavigationOwner, type NavigationGlide, type NavigationLease, type NavigationPresentation, type NavigationSnapshot } from "../engine/babylon/navigationLease";
import type { PanoramaCameraFrame, PanoramaOrb } from "../engine/babylon/panorama/panoramaRenderer";
import type { PanoramaGpuTexture } from "../engine/babylon/panorama/panoramaTextures";
import { createSettingsRegistry } from "../settings/registry";
import { FOSS_EARTH_PARAMETERS } from "../settings/catalogue";
import { loadScene, type SceneFailure, type SceneHandle, type SceneProgress, type SceneRenderer, type SceneRuntime } from "./loadScene";
import { createMemorySceneHistory } from "./sceneHistory";
import { enuFrame, geodeticPoint, scale, add, sub, length, dot, vec3, type Vec3 } from "./panoramaMath";
import { INSIDE_SHARE, orbitAngles } from "./panoramaFlight";
import type { ResourceBackend } from "./panoramaResources";

const GROUND = 250;
const MANIFEST_URL = "https://foss-earth.test/examples/panorama-scenes/campus-pair.scene.json";
// jsdom's import.meta.url is not a file URL; tests run from the repository root.
const PUBLIC = path.join(process.cwd(), "public");
const manifest = JSON.parse(readFileSync(path.join(PUBLIC, "examples/panorama-scenes/campus-pair.scene.json"), "utf8")) as Record<string, unknown>;
// One panorama with previews up to 256 px faces and whole images 1024 and 2048 px wide, in the same folder.
const cardinal = JSON.parse(readFileSync(path.join(PUBLIC, "examples/panorama-scenes/umn-cardinal.scene.json"), "utf8")) as Record<string, unknown>;

function harness(options: { available?: boolean; groundReady?: boolean; canvas?: HTMLCanvasElement; placeCamera?: boolean; prepareTerrain?: SceneRuntime["prepareTerrain"] } = {}) {
  let clock = 0;
  const frameCallbacks = new Set<() => void>();
  const tick = (ms = 16) => { clock += ms; for (const callback of [...frameCallbacks]) callback(); };
  let groundReady = options.groundReady ?? true;
  let presentation: NavigationPresentation | null = null;
  let continuous = 0;
  const restored: NavigationSnapshot[] = [];
  const placed: NavigationPresentation[] = [];
  const glides: { view: NavigationPresentation; pivot: Vec3; motion: NavigationGlide }[] = [];
  const snapshot: NavigationSnapshot = {
    version: 1, view: { latDeg: 44.97, lonDeg: -93.26, headingDeg: 0, pitchDeg: 60, zoomMeters: 600 },
    camera: { center: { x: 1, y: 2, z: 3 }, yaw: 0, pitch: 1, radius: 600, fov: 0.8 },
  };
  const deviceLost = new Set<() => void>();
  const owner = createNavigationOwner({
    unavailable: () => null,
    snapshot: () => snapshot,
    suspend: () => {},
    resume: () => {},
    present: view => { presentation = view; },
    requestRender: () => {},
    beginContinuous: () => { continuous += 1; },
    endContinuous: () => { continuous -= 1; },
  });
  const runtime: SceneRuntime = {
    surface: {
      sample: () => (groundReady ? { heightMeters: GROUND, revision: 1 } as never : null),
      raycast: () => null,
      revision: () => 1,
    },
    acquireNavigation: request => owner.acquire(request),
    captureNavigationSnapshot: () => snapshot,
    restoreNavigationSnapshot: (value, lease) => {
      const held = owner.current();
      if (held && held !== lease) return false;
      restored.push(value);
      return true;
    },
    // A runtime that can put its camera anywhere while a lease holds it, when a test asks for one.
    ...(!options.placeCamera ? {} : {
      placeNavigationCamera: (lease: NavigationLease, view: NavigationPresentation) => {
        if (owner.current() !== lease) return false;
        placed.push(view);
        return true;
      },
      glideNavigationCamera: (lease: NavigationLease, view: NavigationPresentation, pivot: { x: number; y: number; z: number }, motion: NavigationGlide) => {
        if (owner.current() !== lease) return false;
        glides.push({ view, pivot: vec3(pivot), motion });
        return true;
      },
      getCameraHandling: () => ({ pitchDeg: { min: 1, max: 89 }, zoomMeters: { min: 25, max: 25_000_000 }, glideKeepPerFrame: 0.82 }),
    }),
    getPresentationView: () => owner.current()?.getPresentationView() ?? null,
    setNavigationIntentHandler: () => () => {},
    requestRender: () => {},
    beginContinuous: () => { continuous += 1; },
    endContinuous: () => { continuous -= 1; },
    onDeviceLost: listener => { deviceLost.add(listener); return () => deviceLost.delete(listener); },
    onDeviceRestored: () => () => {},
    prepareTerrain: vi.fn(options.prepareTerrain ?? (async () => ({ groundHeightMeters: GROUND, altitudeMeters: GROUND }))),
    // Only a canvas for the look input, when a test asks for one.
    ...(options.canvas ? { scene: { getEngine: () => ({ getRenderingCanvas: () => options.canvas, getHardwareScalingLevel: () => 1, getCaps: () => ({ maxTextureSize: 8192 }) }) } as never } : {}),
  };

  // The camera: 100 m south of the pair's photograph at its height, looking north.
  const frame = enuFrame(-93.235, 44.974 - 40 / 111_111);
  const marker = geodeticPoint(-93.235, 44.974 - 40 / 111_111, GROUND + 12);
  const eye: Vec3 = add(marker, scale(frame.north, -100));
  const cameraFrame = (): PanoramaCameraFrame => {
    const view = presentation
      ? { forward: [presentation.forward.x, presentation.forward.y, presentation.forward.z] as Vec3, up: [presentation.up.x, presentation.up.y, presentation.up.z] as Vec3, verticalFovRad: presentation.verticalFovRad }
      : { forward: frame.north, up: frame.up, verticalFovRad: Math.PI / 3 };
    return { eye, viewRotProj: null as never, inverseViewRotProj: null as never, view: { ...view, right: frame.east, aspect: 1.5 }, viewportHeightCssPx: 800, revision: "r" };
  };
  const orbs = new Map<string, { state: Record<string, unknown>; expansions: unknown[]; disposed: boolean }>();
  const shown: unknown[] = [];
  const renderer: SceneRenderer = {
    available: options.available ?? true,
    unavailableReason: options.available === false ? "WebGL" : null,
    addOrb(id, state): PanoramaOrb {
      const record = { state: { ...state } as Record<string, unknown>, expansions: [] as unknown[], disposed: false };
      orbs.set(id, record);
      return {
        id,
        update: next => Object.assign(record.state, next),
        setExpansion: expansion => record.expansions.push(expansion),
        effectiveRadius: () => 2,
        dispose: () => { record.disposed = true; },
      };
    },
    immersion: { show: state => shown.push(state), get visible() { return shown.at(-1) !== null; } },
    setAppearance: () => {},
    cameraFrame,
    pick: () => [],
    project: () => ({ x: 10, y: 10 }),
    dispose: vi.fn(),
  };

  const textures: { disposed: boolean }[] = [];
  let pendingUploads: (() => void)[] = [];
  let holdUploads = false;
  const texture = (kind: "cube" | "equirectangular"): PanoramaGpuTexture => {
    const value = { kind, width: 1, height: 1, levels: 1, gpuBytes: 0, texture: {} as BaseTexture, complete: true, disposed: false, dispose() { value.disposed = true; } };
    textures.push(value);
    return value;
  };
  const upload = (kind: "cube" | "equirectangular") => new Promise<PanoramaGpuTexture>(resolve => {
    if (holdUploads) pendingUploads.push(() => resolve(texture(kind)));
    else resolve(texture(kind));
  });
  let failing: RegExp | null = null;
  const failures: SceneFailure[] = [];
  const progress: SceneProgress[] = [];
  const backend: ResourceBackend<PanoramaGpuTexture> = {
    async fetch(url) {
      if (failing?.test(url)) throw new TypeError("Failed to fetch");
      return new Response(readFileSync(path.join(PUBLIC, new URL(url).pathname)), { headers: { "content-type": "image/jpeg" } });
    },
    async decode() { return { width: 1, height: 1, close() {} } as unknown as ImageBitmap; },
    uploadCube: () => upload("cube"),
    uploadEquirect: () => upload("equirectangular"),
    maxTextureSide: () => 8192,
  };
  const settings = createSettingsRegistry({ storage: null });
  settings.register(FOSS_EARTH_PARAMETERS);
  const history = createMemorySceneHistory();

  const load = (reduced = false, document: Record<string, unknown> = manifest) => loadScene(runtime, document, {
    baseUrl: MANIFEST_URL, settings, history, onFailure: failure => failures.push(failure), onProgress: update => progress.push(update),
    internals: {
      renderer, backend, now: () => clock, reducedMotion: () => reduced,
      onFrame: callback => { frameCallbacks.add(callback); return () => frameCallbacks.delete(callback); },
    },
  });
  return {
    load, tick, runtime, owner, orbs, shown, restored, placed, glides, textures, history, settings, failures, progress, backend,
    clock: () => clock,
    /** Image requests whose URL matches fail as a stopped server's do; null lets them through. */
    failFetches: (pattern: RegExp | null) => { failing = pattern; },
    presentation: () => presentation,
    continuous: () => continuous,
    setGround: (ready: boolean) => { groundReady = ready; },
    holdUploads: () => { holdUploads = true; },
    releaseUploads: () => { const run = pendingUploads; pendingUploads = []; run.forEach(fn => fn()); },
    loseDevice: () => { owner.end("device-lost"); for (const listener of deviceLost) listener(); },
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
async function settle(h: ReturnType<typeof harness>, frames = 40) {
  for (let i = 0; i < frames; i++) { h.tick(); await flush(); }
}
async function loaded(h: ReturnType<typeof harness>, reduced = false, document?: Record<string, unknown>): Promise<SceneHandle> {
  const result = await h.load(reduced, document);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  await settle(h);
  return result.handle;
}

let handles: SceneHandle[] = [];
afterEach(() => { handles.forEach(handle => handle.dispose()); handles = []; });

describe("loadScene", () => {
  it("fails an invalid manifest before any request", async () => {
    const h = harness();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await loadScene(h.runtime, { ...manifest, version: 2 }, { baseUrl: MANIFEST_URL, history: null });
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps placements pending until the ground is displayed, then places each orb above it and opens the overview", async () => {
    const h = harness({ groundReady: false, prepareTerrain: () => new Promise(() => {}) });
    const handle = await loaded(h);
    handles.push(handle);
    expect(handle.status.entries.map(entry => entry.placement)).toEqual(["pending", "pending"]);
    expect(handle.status.overview).toBe("pending");
    expect(h.restored).toHaveLength(0);
    expect(h.runtime.prepareTerrain).toHaveBeenCalledOnce();
    h.setGround(true);
    await settle(h, 2);
    expect(handle.status.entries.map(entry => entry.placement)).toEqual(["placed", "placed"]);
    expect(handle.status.entries.every(entry => entry.preview === "ready")).toBe(true);
    expect(handle.status.overview).toBe("applied");
    expect(h.restored).toHaveLength(1);
    expect(h.orbs.get("pair-photo")!.state.marker).not.toBeNull();
  });

  it("opens the overview without waiting for previews, and shows one preview while another still downloads", async () => {
    const h = harness({ groundReady: false });
    const fetchImage = h.backend.fetch;
    let releaseGrid!: () => void;
    const gridGate = new Promise<void>(resolve => { releaseGrid = resolve; });
    h.backend.fetch = async (url, init) => {
      if (url.includes("cardinal-grid")) await gridGate;
      return fetchImage(url, init);
    };
    const result = await h.load();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const handle = result.handle;
    handles.push(handle);
    await vi.waitFor(() => expect(handle.status.entries.find(entry => entry.id === "pair-photo")?.preview).toBe("ready"));
    expect(handle.status.overview).toBe("applied");
    expect(handle.status.entries.find(entry => entry.id === "pair-grid")?.preview).toBe("loading");
    expect(h.orbs.get("pair-photo")!.state.texture).not.toBeNull();
    expect(handle.status.entries.find(entry => entry.id === "pair-photo")?.previewDetail?.representation).toBe("preview-64");
    expect(h.orbs.get("pair-grid")!.state.texture).toBeNull();
    expect(h.progress.some(event => event.kind === "image")).toBe(false);
    expect(h.progress.some(event => event.kind === "preview" && event.receivedBytes > 0)).toBe(true);
    releaseGrid();
    await vi.waitFor(() => expect(handle.status.entries.every(entry => entry.preview === "ready")).toBe(true));
  });

  it("cancels automatic terrain preparation on new input and ignores its late result", async () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    let finish!: (value: { groundHeightMeters: number; altitudeMeters: number }) => void;
    let signal: AbortSignal | undefined;
    const h = harness({ canvas, groundReady: false, prepareTerrain: request => {
      signal = request.signal;
      return new Promise(resolve => { finish = resolve; });
    } });
    const result = await h.load();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    handles.push(result.handle);
    const input = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    canvas.dispatchEvent(input);
    expect(input.defaultPrevented).toBe(false);
    expect(signal?.aborted).toBe(true);
    finish({ groundHeightMeters: GROUND, altitudeMeters: GROUND });
    h.setGround(true);
    await settle(h, 2);
    expect(h.restored).toHaveLength(0);
    expect(result.handle.status.overview).toBe("none");
    expect(h.failures).toHaveLength(0);
    canvas.remove();
  });

  it("does not apply an externally cancelled overview after its terrain arrives", async () => {
    let finish!: (value: { groundHeightMeters: number; altitudeMeters: number }) => void;
    const h = harness({ groundReady: false, prepareTerrain: () => new Promise(resolve => { finish = resolve; }) });
    const result = await h.load();
    if (!result.ok) throw new Error("Expected valid scene");
    handles.push(result.handle);
    const controller = new AbortController();
    const overview = result.handle.showOverview({ signal: controller.signal });
    controller.abort();
    finish({ groundHeightMeters: GROUND, altitudeMeters: GROUND });
    expect(await overview).toMatchObject({ ok: false, reason: "cancelled" });
    h.setGround(true);
    await settle(h, 2);
    expect(result.handle.status.overview).toBe("none");
    expect(h.restored).toHaveLength(0);
  });

  it("gives up a pending overview when a controller or the host changes the camera", async () => {
    let finish!: (value: { groundHeightMeters: number; altitudeMeters: number }) => void;
    let signal: AbortSignal | undefined;
    const h = harness({ groundReady: false, prepareTerrain: request => {
      signal = request.signal;
      return new Promise(resolve => { finish = resolve; });
    } });
    const result = await h.load();
    if (!result.ok) throw new Error("Expected valid scene");
    handles.push(result.handle);
    const snapshot = h.runtime.captureNavigationSnapshot()!;
    h.runtime.captureNavigationSnapshot = () => ({ ...snapshot, view: { ...snapshot.view, headingDeg: 20 } });
    h.tick();
    expect(signal?.aborted).toBe(true);
    finish({ groundHeightMeters: GROUND, altitudeMeters: GROUND });
    h.setGround(true);
    await settle(h, 2);
    expect(result.handle.status.overview).toBe("none");
    expect(h.restored).toHaveLength(0);
  });

  it("reports a streamed manifest's actual bytes and turns interrupted bodies into scene failures", async () => {
    const h = harness();
    const updates: SceneProgress[] = [];
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } })));
    const loading = loadScene(h.runtime, MANIFEST_URL, { settings: h.settings, onProgress: event => updates.push(event) });
    stream.enqueue(new TextEncoder().encode('{"format":'));
    await vi.waitFor(() => expect(updates.at(-1)?.receivedBytes).toBe(10));
    expect(updates.at(-1)).toMatchObject({ kind: "manifest", totalBytes: null, state: "loading" });
    stream.error(new Error("Connection interrupted"));
    expect(await loading).toMatchObject({ ok: false, errors: [{ path: "$", message: expect.stringContaining("Connection interrupted") }] });
    expect(updates.at(-1)?.state).toBe("failed");
    fetchMock.mockRestore();
  });

  it("without the flight, enters through an expanding reveal, hands off with the camera's own view, and exits to the overview it left", async () => {
    const h = harness({ placeCamera: true });
    h.settings.set("scene.panorama.flightDuration", "off");
    const handle = await loaded(h);
    handles.push(handle);
    const entering = handle.enter("pair-photo");
    await settle(h, 40);
    expect(await entering).toEqual({ ok: true });
    expect(handle.status.phase).toBe("immersive");
    const expansions = h.orbs.get("pair-photo")!.expansions.filter(Boolean) as { radiusMeters: number; reveal: number }[];
    expect(expansions.length).toBeGreaterThan(3);
    expect(expansions.at(-1)!.reveal).toBe(1);
    expect(expansions.at(-1)!.radiusMeters).toBeGreaterThan(expansions[0].radiusMeters);
    expect(h.orbs.get("pair-photo")!.expansions.at(-1)).toBeNull();
    // Handoff keeps the camera's direction; levelling then keeps the heading (north).
    expect(handle.status.view!.headingDeg).toBeCloseTo(0, 6);
    expect(h.presentation()).not.toBeNull();
    expect(handle.status.credits.map(credit => credit.assetId)).toEqual(["buikslotermeerplein-512"]);

    const overviewBefore = h.owner.current()!.overview;
    const exiting = handle.exit();
    await settle(h, 20);
    expect(await exiting).toEqual({ ok: true });
    expect(handle.status.phase).toBe("overview");
    expect(h.owner.current()).toBeNull();
    expect(h.restored.at(-1)).toBe(overviewBefore);
    expect(h.shown.at(-1)).toBeNull();
    expect(h.continuous()).toBe(0);
    expect(h.placed).toHaveLength(0);
  });

  it("flies the camera into the orb and hands off inside it, then pulls back out facing the way the view faces", async () => {
    const h = harness({ placeCamera: true });
    const handle = await loaded(h);
    handles.push(handle);
    const photo = h.orbs.get("pair-photo")!;
    const entering = handle.enter("pair-grid");
    await settle(h, 80);
    expect(await entering).toEqual({ ok: true });
    const grid = h.orbs.get("pair-grid")!;
    const marker = grid.state.marker as Vec3;
    // From the camera's own eye, 100 m south, straight to half the orb's radius inside it.
    const into = [...h.placed];
    const distance = (view: NavigationPresentation, to: Vec3) => length(sub(to, vec3(view.position)));
    expect(into.length).toBeGreaterThan(3);
    expect(distance(into[0], marker)).toBeGreaterThan(90);
    expect(distance(into.at(-1)!, marker)).toBeCloseTo(2 * INSIDE_SHARE, 6);
    for (let i = 1; i < into.length; i++) expect(distance(into[i], marker)).toBeLessThanOrEqual(distance(into[i - 1], marker));
    // A sphere of the orb's size when the flight began, revealed over everything as the camera arrives.
    const inward = grid.expansions.filter(Boolean) as { radiusMeters: number; reveal: number; source?: unknown }[];
    expect(new Set(inward.map(each => each.radiusMeters))).toEqual(new Set([2]));
    expect(inward.at(-1)!.reveal).toBe(1);
    expect(grid.expansions.at(-1)).toBeNull();
    expect(h.presentation()).not.toBeNull();
    expect(handle.status.phase).toBe("immersive");

    // Turned to face east by a link, into the other orb.
    const following = handle.follow("to-photo-facing-east");
    await settle(h, 40);
    expect(await following).toEqual({ ok: true });
    const overview = h.owner.current()!.overview;
    h.placed.length = 0;
    const exiting = handle.exit();
    expect(handle.exit()).toBe(exiting);
    await settle(h, 80);
    expect(await exiting).toEqual({ ok: true });
    const out = [...h.placed];
    const photoMarker = photo.state.marker as Vec3;
    const outward = photo.expansions.filter(Boolean) as { radiusMeters: number; reveal: number; source?: unknown }[];
    const radius = outward[0].radiusMeters;
    // Starts inside the sphere, drawing the image on screen over everything, not the orb's preview, with the view's own look.
    expect(distance(out[0], photoMarker)).toBeCloseTo(radius * INSIDE_SHARE, 6);
    expect(outward[0]).toMatchObject({ reveal: 1, source: expect.objectContaining({ kind: "equirectangular" }) });
    expect(outward.at(-1)!.reveal).toBe(0);
    expect(new Set(outward.map(each => each.radiusMeters)).size).toBe(1);
    expect(photo.expansions.at(-1)).toBeNull();
    const east = enuFrame(-93.235, 44.974).east;
    expect(dot(vec3(out[0].forward), east)).toBeCloseTo(1, 6);
    // Ends as the globe camera's orbit of the orb: still facing east, at the overview's pitch, distance and field of view.
    const end = h.restored.at(-1)!;
    expect(end).not.toBe(overview);
    expect(vec3(end.camera.center)).toEqual(photoMarker);
    expect(end.camera).toMatchObject({ pitch: overview.camera.pitch, radius: overview.camera.radius, fov: overview.camera.fov });
    expect(orbitAngles(photoMarker, vec3(out.at(-1)!.forward), 0).yaw).toBeCloseTo(end.camera.yaw, 9);
    expect(end.camera.yaw).toBeCloseTo(Math.PI / 2, 2);
    expect(distance(out.at(-1)!, photoMarker)).toBeCloseTo(overview.camera.radius, 6);
    expect(handle.status.phase).toBe("overview");
    expect(h.presentation()).toBeNull();
    expect(h.shown.at(-1)).toBeNull();
    expect(h.owner.current()).toBeNull();
    expect(h.continuous()).toBe(0);
  });

  it("gives the camera to the globe where a flight out cut short by Escape got to, moving on outward, and a Back during it joins the exit", async () => {
    const h = harness({ placeCamera: true });
    const handle = await loaded(h);
    handles.push(handle);
    const entering = handle.enter("pair-photo");
    await settle(h, 80);
    await entering;
    const photo = h.orbs.get("pair-photo")!;
    const marker = photo.state.marker as Vec3;
    const startedAt = h.clock();
    const exiting = handle.exit();
    await settle(h, 5);
    expect(handle.status.phase).toBe("exiting");
    // Links are not followed on the way out.
    expect(await handle.follow("to-grid")).toMatchObject({ ok: false, reason: "unavailable" });
    const cutAt = h.placed.at(-1)!;
    const placedBefore = h.placed.length;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    h.history.back();
    expect(await exiting).toEqual({ ok: true });
    // At once: the globe has the camera, and input, where the flight got to.
    expect(handle.status.phase).toBe("overview");
    expect(h.owner.current()).toBeNull();
    expect(h.placed.length).toBe(placedBefore);
    expect(h.glides).toHaveLength(1);
    const [{ view, pivot, motion }] = h.glides;
    expect(view).toEqual(cutAt);
    expect(pivot).toEqual(marker);
    // Still backing away from the orb, as fast as the flight was; the field of view goes back to the overview's.
    const away = sub(vec3(view.position), marker);
    expect(dot(vec3(motion.velocity), away)).toBeGreaterThan(0);
    expect(length(vec3(motion.velocity))).toBeGreaterThan(1);
    expect(motion).toMatchObject({ fovRad: 0.8, inputSince: startedAt, press: null });
    // The sphere turns back into the orb as the glide slows, and then the orb is itself again.
    await settle(h, 3);
    const fading = photo.expansions.slice(-3) as { reveal: number; radiusMeters: number }[];
    expect(fading.every(each => each !== null)).toBe(true);
    expect(fading[2].reveal).toBeLessThan(fading[0].reveal);
    await settle(h, 60);
    expect(photo.expansions.at(-1)).toBeNull();
    expect(h.continuous()).toBe(0);
  });

  it("gives the camera to the globe at once where a flight in cut short by a swipe got to, moving on toward the orb, entering nothing", async () => {
    // On the page, so its events reach the window as a canvas's do.
    const canvas = document.body.appendChild(document.createElement("canvas"));
    const h = harness({ placeCamera: true, canvas });
    const now = vi.spyOn(performance, "now").mockImplementation(() => h.clock());
    try {
      const handle = await loaded(h);
      handles.push(handle);
      const startedAt = h.clock();
      const entering = handle.enter("pair-grid");
      await settle(h, 20);
      const grid = h.orbs.get("pair-grid")!;
      const marker = grid.state.marker as Vec3;
      const cutAt = h.placed.at(-1)!;
      const swipedAt = h.clock();
      canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 10, bubbles: true }));
      expect(await entering).toMatchObject({ ok: false, reason: "cancelled" });
      expect(handle.status.phase).toBe("overview");
      expect(h.owner.current()).toBeNull();
      const [{ view, motion }] = h.glides;
      expect(view).toEqual(cutAt);
      expect(dot(vec3(motion.velocity), sub(marker, vec3(view.position)))).toBeGreaterThan(0);
      // The swipe began after the flight did, so it goes on to the globe.
      expect(motion.inputSince).toBeGreaterThanOrEqual(startedAt);
      expect(motion.inputSince).toBeLessThan(swipedAt);
      expect(h.history.entries()).toHaveLength(0);
      await settle(h, 60);
      expect(grid.expansions.at(-1)).toBeNull();
      expect(h.continuous()).toBe(0);
    } finally {
      now.mockRestore();
      canvas.remove();
    }
  });

  it("gives a mouse press that cuts a flight short to the globe, as a drag from where it is", async () => {
    const canvas = document.body.appendChild(document.createElement("canvas"));
    const h = harness({ placeCamera: true, canvas });
    try {
      const handle = await loaded(h);
      handles.push(handle);
      const entering = handle.enter("pair-grid");
      await settle(h, 20);
      canvas.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 7, pointerType: "mouse", button: 0, clientX: 300, clientY: 200, bubbles: true }));
      expect(await entering).toMatchObject({ ok: false, reason: "cancelled" });
      expect(h.glides.at(-1)!.motion.press).toEqual({ pointerId: 7, button: 0, clientX: 300, clientY: 200 });
    } finally {
      canvas.remove();
    }
  });

  it("lets an entry take over from a flight cut short while its sphere is still turning back into the orb", async () => {
    const canvas = document.body.appendChild(document.createElement("canvas"));
    const h = harness({ placeCamera: true, canvas });
    const now = vi.spyOn(performance, "now").mockImplementation(() => h.clock());
    try {
      const handle = await loaded(h);
      handles.push(handle);
      const first = handle.enter("pair-grid");
      await settle(h, 20);
      canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 10, bubbles: true }));
      await settle(h, 2);
      expect(await first).toMatchObject({ ok: false, reason: "cancelled" });
      const second = handle.enter("pair-grid");
      await settle(h, 80);
      expect(await second).toEqual({ ok: true });
      expect(handle.status.phase).toBe("immersive");
    } finally {
      now.mockRestore();
      canvas.remove();
    }
  });

  it("gives the camera to the globe at rest where a flight out got to when an entry takes over", async () => {
    const h = harness({ placeCamera: true });
    const handle = await loaded(h);
    handles.push(handle);
    const first = handle.enter("pair-photo");
    await settle(h, 80);
    expect(await first).toEqual({ ok: true });
    const exiting = handle.exit();
    await settle(h, 10);
    const cutAt = h.placed.at(-1)!;
    const entering = handle.enter("pair-grid");
    expect(await exiting).toEqual({ ok: true });
    const [{ view, motion }] = h.glides;
    expect(view).toEqual(cutAt);
    expect(motion.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(h.orbs.get("pair-photo")!.expansions.at(-1)).toBeNull();
    await settle(h, 80);
    expect(await entering).toEqual({ ok: true });
    expect(handle.status.phase).toBe("immersive");
  });

  it("does not take a swipe's momentum for input: Escape while the image glides still pulls out all the way", async () => {
    // On the page, so its events reach the window as a canvas's do.
    const canvas = document.body.appendChild(document.createElement("canvas"));
    const h = harness({ placeCamera: true, canvas });
    const now = vi.spyOn(performance, "now").mockImplementation(() => h.clock());
    try {
      const handle = await loaded(h);
      handles.push(handle);
      const entering = handle.enter("pair-photo");
      await settle(h, 80);
      expect(await entering).toEqual({ ok: true });
      const swipe = () => canvas.dispatchEvent(new WheelEvent("wheel", { deltaX: 12.5, bubbles: true, cancelable: true }));
      for (let i = 0; i < 5; i++) { swipe(); await settle(h, 1); }
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      // The momentum goes on through the whole flight out.
      for (let i = 0; i < 80; i++) { swipe(); await settle(h, 1); }
      expect(handle.status.phase).toBe("overview");
      expect(h.restored.at(-1)!.camera.radius).toBe(600);
    } finally {
      now.mockRestore();
      canvas.remove();
    }
  });

  it("completes an exit whose flight the runtime ends, at the overview it left", async () => {
    const h = harness({ placeCamera: true });
    const handle = await loaded(h);
    handles.push(handle);
    const entering = handle.enter("pair-photo");
    await settle(h, 80);
    await entering;
    const overview = h.owner.current()!.overview;
    const exiting = handle.exit();
    await settle(h, 5);
    h.loseDevice();
    await flush();
    expect(await exiting).toEqual({ ok: true });
    expect(handle.status.phase).toBe("overview");
    expect(h.restored.at(-1)).toBe(overview);
    expect(h.orbs.get("pair-photo")!.expansions.at(-1)).toBeNull();
  });

  it("keeps the reveal and the fade when the runtime cannot move its camera or motion is reduced", async () => {
    for (const [options, reduced] of [[{}, false], [{ placeCamera: true }, true]] as const) {
      const h = harness(options);
      const handle = await loaded(h, reduced);
      handles.push(handle);
      const entering = handle.enter("pair-photo");
      await settle(h, 40);
      expect(await entering).toEqual({ ok: true });
      const overview = h.owner.current()!.overview;
      const exiting = handle.exit();
      await settle(h, 20);
      await exiting;
      expect(h.placed).toHaveLength(0);
      expect(h.restored.at(-1)).toBe(overview);
    }
  });

  it("draws the scene's outline, grows a hovered orb to its hover scale and back, and resets it on entering", async () => {
    const h = harness();
    const handle = await loaded(h, false, { ...manifest, markerStyle: { outline: { color: "#ffcc00", widthPx: 2 }, hover: { scale: 2 } } });
    handles.push(handle);
    const photo = h.orbs.get("pair-photo")!;
    expect(photo.state.outline).toEqual({ color: [1, 0.8, 0, 1], widthPx: 2 });
    expect(photo.state.displayScale).toBe(1);
    expect(h.continuous()).toBe(0);

    handle.hover("pair-photo");
    expect(handle.status.hovered).toBe("pair-photo");
    expect(h.continuous()).toBe(1);
    // Half of scene.panorama.hoverDuration's 120 ms, eased.
    h.tick(60);
    expect(photo.state.displayScale).toBeCloseTo(1.5, 9);
    h.tick(60);
    expect(photo.state.displayScale).toBe(2);
    expect(h.continuous()).toBe(0);
    handle.hover(null);
    h.tick(120);
    expect(photo.state.displayScale).toBe(1);
    expect(h.continuous()).toBe(0);

    handle.hover("pair-photo");
    h.tick(120);
    const entering = handle.enter("pair-photo");
    await settle(h, 40);
    expect(await entering).toEqual({ ok: true });
    expect(photo.state.displayScale).toBe(1);
    expect(handle.status.hovered).toBeNull();
    // Only the overview's orbs are hovered.
    handle.hover("pair-grid");
    expect(handle.status.hovered).toBeNull();
    expect(h.continuous()).toBe(0);
  });

  it("turns the view every frame while an arrow key is held, and glides after a flick, holding rendering only meanwhile", async () => {
    const canvas = document.createElement("canvas");
    Object.assign(canvas, { setPointerCapture: () => {}, releasePointerCapture: () => {} });
    document.body.append(canvas);
    const h = harness({ canvas });
    const handle = await loaded(h);
    handles.push(handle);
    const entering = handle.enter("pair-photo");
    await settle(h, 40);
    await entering;
    await settle(h, 20);
    const heading = () => handle.status.view!.headingDeg;
    const start = heading();
    expect(h.continuous()).toBe(0);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    h.tick(100);
    h.tick(100);
    // scene.panorama.lookRate: 90°/s.
    expect(heading() - start).toBeCloseTo(18, 6);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight" }));
    h.tick(100);
    expect(heading() - start).toBeCloseTo(18, 6);
    expect(h.continuous()).toBe(0);

    // A flick: nothing glides while the pointer holds the image, and it glides on after the release.
    const pointer = (type: string, x: number, timeStamp: number) => {
      const event = new PointerEvent(type, { pointerId: 1, pointerType: "mouse", button: 0, clientX: x, clientY: 300, bubbles: true, cancelable: true });
      Object.defineProperty(event, "timeStamp", { value: timeStamp });
      canvas.dispatchEvent(event);
    };
    pointer("pointerdown", 400, 1000);
    pointer("pointermove", 380, 1010);
    const held = heading();
    h.tick(16);
    expect(heading()).toBe(held);
    pointer("pointerup", 380, 1015);
    h.tick(16);
    expect(heading()).toBeGreaterThan(held);
    await settle(h, 80);
    expect(h.continuous()).toBe(0);

    // Held still before the release: no glide.
    const before = heading();
    pointer("pointerdown", 400, 5000);
    pointer("pointermove", 380, 5010);
    pointer("pointerup", 380, 5200);
    h.tick(16);
    expect(heading()).toBeCloseTo(before + 3, 9);
    canvas.remove();
  });

  it("shows the largest image the image detail allows, says why nothing larger is, and chooses again when the detail moves", async () => {
    const h = harness();
    const handle = await loaded(h, false, cardinal);
    handles.push(handle);
    const [entry] = handle.status.entries;
    expect(entry.images.map(image => [image.id, image.aroundPx])).toEqual([
      ["preview-32", 128], ["preview-64", 256], ["preview-128", 512], ["preview-256", 1024], ["whole-1024", 1024], ["whole-2048", 2048],
    ]);
    const entering = handle.enter(entry.id);
    await settle(h, 60);
    expect(await entering).toEqual({ ok: true });
    // The default: the largest, which is all the panorama offers.
    expect(handle.status.immersionDetail).toEqual({ representation: "whole-2048", limitation: null, loading: null });
    expect(h.settings.getReading("scene.panorama.immersionWidth")).toBe("2048 px on screen");

    h.settings.set("scene.panorama.immersionWidth", 1500);
    await settle(h, 40);
    expect(handle.status.immersionDetail).toEqual({
      representation: "whole-1024", loading: null,
      limitation: "The 2048 px image is more than the 1500 px image detail allows.",
    });
    // Below every whole image: the orb's preview, which is loaded anyway.
    h.settings.set("scene.panorama.immersionWidth", 256);
    await settle(h, 40);
    expect(handle.status.immersionDetail!.representation).toBe("preview-128");
    h.settings.reset("scene.panorama.immersionWidth");
    await settle(h, 40);
    expect(handle.status.immersionDetail).toEqual({ representation: "whole-2048", limitation: null, loading: null });
  });

  it("names the budget that keeps a larger image out, and loads it once the budget allows", async () => {
    const h = harness();
    h.settings.set("scene.panorama.sourceGpuMiB", 2);
    const handle = await loaded(h, false, cardinal);
    handles.push(handle);
    const entering = handle.enter(handle.status.entries[0].id);
    await settle(h, 60);
    expect(await entering).toEqual({ ok: true });
    expect(handle.status.immersionDetail!.representation).toMatch(/^preview-/);
    expect(handle.status.immersionDetail!.limitation).toMatch(/^The 1024 px image needs 2\.7 MiB of GPU memory with its mips; [\d.]+ MiB of the 2\.0 MiB panorama GPU memory is free \(Scenes → Loading and memory\)\.$/);
    h.settings.set("scene.panorama.sourceGpuMiB", 64);
    await settle(h, 40);
    expect(handle.status.immersionDetail).toEqual({ representation: "whole-2048", limitation: null, loading: null });
  });

  it("reports a larger image that fails to load, keeps the one on screen, and says why in the detail", async () => {
    const h = harness();
    const handle = await loaded(h, false, cardinal);
    handles.push(handle);
    const [entry] = handle.status.entries;
    // The server stops after the previews arrived, as when the dev server is closed.
    h.failFetches(/immersion-/);
    const entering = handle.enter(entry.id);
    await settle(h, 60);
    expect(await entering).toEqual({ ok: true });
    const url = new URL("media/cardinal-grid/immersion-2048.jpg", new URL("umn-cardinal.scene.json", MANIFEST_URL)).href;
    expect(handle.status.immersionDetail).toEqual({
      representation: expect.stringMatching(/^preview-/), loading: null,
      limitation: `The 2048 px image could not be loaded: ${url} could not be fetched: Failed to fetch.`,
    });
    expect(h.failures).toEqual([{
      kind: "image", panorama: { id: entry.id, title: entry.title },
      cause: `${url} could not be fetched: Failed to fetch`,
      message: expect.stringMatching(new RegExp(`^${entry.title}: the 2048 px image could not be loaded, so the \\d+ px preview cube stays on screen: ${url.replace(/[.?]/g, "\\$&")} could not be fetched: Failed to fetch\\.$`)),
    }]);
    // Loading again once the server is back.
    h.failFetches(null);
    h.settings.set("scene.panorama.immersionWidth", 2048);
    await settle(h, 40);
    expect(handle.status.immersionDetail).toEqual({ representation: "whole-2048", limitation: null, loading: null });
    expect(h.failures).toHaveLength(1);
  });

  it("reports an orb's preview that fails in the background, and entering it once, not twice", async () => {
    const h = harness();
    h.failFetches(/preview-/);
    const handle = await loaded(h, false, cardinal);
    handles.push(handle);
    const [entry] = handle.status.entries;
    expect(entry.preview).toBe("failed");
    expect(h.failures.map(failure => [failure.kind, failure.panorama?.id])).toEqual([["preview", entry.id]]);
    expect(h.failures[0].message).toMatch(new RegExp(`^${entry.title}: its preview could not be loaded: .+ could not be fetched: Failed to fetch\\.$`));
    expect(await handle.enter(entry.id)).toMatchObject({ ok: false, reason: "failed" });
    expect(h.failures.map(failure => failure.kind)).toEqual(["preview", "navigation"]);
    expect(h.failures[1].message).toMatch(new RegExp(`^${entry.title} could not be entered: .+ could not be fetched: Failed to fetch\\.$`));
  });

  it("follows a link, keeps the original overview, and Back from B returns to A", async () => {
    const h = harness();
    const handle = await loaded(h);
    handles.push(handle);
    const entering = handle.enter("pair-photo");
    await settle(h);
    await entering;
    const overview = h.owner.current()!.overview;
    const following = handle.follow("to-grid");
    await settle(h);
    expect(await following).toEqual({ ok: true });
    expect(handle.status.active).toBe("pair-grid");
    expect(h.history.entries().map(entry => entry.destination)).toEqual([null, "pair-photo", "pair-grid"]);
    h.history.back();
    await settle(h);
    expect(handle.status.active).toBe("pair-photo");
    expect(h.history.entries().map(entry => entry.destination)).toEqual([null, "pair-photo"]);
    h.history.forward();
    await settle(h);
    expect(handle.status.active).toBe("pair-grid");
    const exiting = handle.exit();
    await settle(h);
    await exiting;
    expect(h.restored.at(-1)).toBe(overview);
    expect(h.history.entries().map(entry => entry.destination)).toEqual([null, "pair-photo", "pair-grid", null]);
  });

  it("uses an explicit arrival view on a link, and cuts under reduced motion", async () => {
    const h = harness();
    const handle = await loaded(h, true);
    handles.push(handle);
    const entering = handle.enter("pair-grid");
    await settle(h, 3);
    await entering;
    const expansions = h.orbs.get("pair-grid")!.expansions.filter(Boolean);
    expect(expansions).toHaveLength(0);
    const following = handle.follow("to-photo-facing-east");
    await settle(h, 3);
    await following;
    expect(handle.status.view).toMatchObject({ headingDeg: 90, pitchDeg: 0, verticalFovDeg: 70 });
  });

  it("cancels an entry to the prior view, holding nothing and pushing no history", async () => {
    const h = harness();
    h.holdUploads();
    const handle = await loaded(h);
    handles.push(handle);
    h.releaseUploads();
    await settle(h, 2);
    const controller = new AbortController();
    const entering = handle.enter("pair-photo", { signal: controller.signal });
    await settle(h, 3);
    controller.abort();
    await settle(h, 3);
    expect(await entering).toMatchObject({ ok: false, reason: "cancelled" });
    expect(handle.status.phase).toBe("overview");
    expect(h.owner.current()).toBeNull();
    expect(h.continuous()).toBe(0);
    expect(h.history.entries()).toHaveLength(0);
    expect(h.orbs.get("pair-photo")!.expansions.at(-1)).toBeNull();
  });

  it("ends immersion at the overview when the device is lost, and reloads previews after", async () => {
    const h = harness();
    const handle = await loaded(h);
    handles.push(handle);
    const entering = handle.enter("pair-photo");
    await settle(h);
    await entering;
    const overview = h.owner.current()!.overview;
    h.loseDevice();
    await settle(h, 2);
    expect(handle.status.phase).toBe("overview");
    expect(h.restored.at(-1)).toBe(overview);
    expect(handle.status.entries.every(entry => entry.preview !== "ready")).toBe(true);
    expect(h.textures.every(texture => texture.disposed)).toBe(true);
  });

  it("keeps the scene when a replacement is invalid, and swaps atomically when it is valid", async () => {
    const h = harness();
    const handle = await loaded(h);
    handles.push(handle);
    const bad = await handle.replace({ ...manifest, entities: [{ id: "x", type: "panorama" }] });
    expect(bad.ok).toBe(false);
    expect(handle.status.sceneId).toBe("campus-pair");
    const entering = handle.enter("pair-photo");
    await settle(h);
    await entering;
    const next = await handle.replace({ ...manifest, id: "campus-pair-2", revision: "2" });
    expect(next).toEqual({ ok: true });
    expect(handle.status).toMatchObject({ sceneId: "campus-pair-2", phase: "overview", generation: 2 });
    expect(h.owner.current()).toBeNull();
    expect(h.orbs.get("pair-photo")!.disposed).toBe(false);
  });

  it("disposes everything once, and a late upload cannot bring an orb back", async () => {
    const h = harness();
    h.holdUploads();
    const handle = await loaded(h);
    const entering = handle.enter("pair-photo");
    await settle(h, 2);
    handle.dispose();
    handle.dispose();
    h.releaseUploads();
    await settle(h, 3);
    expect(await entering).toMatchObject({ ok: false });
    expect([...h.orbs.values()].every(orb => orb.disposed)).toBe(true);
    expect([...h.orbs.values()].every(orb => orb.state.texture === null)).toBe(true);
    expect(h.textures.every(texture => texture.disposed)).toBe(true);
    expect(h.owner.current()).toBeNull();
    expect(h.continuous()).toBe(0);
    expect(await handle.enter("pair-photo")).toMatchObject({ ok: false, reason: "disposed" });
  });

  it("lists every panorama and refuses entry when panoramas cannot be drawn", async () => {
    const h = harness({ available: false });
    const handle = await loaded(h);
    handles.push(handle);
    expect(handle.status.entries).toHaveLength(2);
    expect(handle.status.renderingAvailable).toBe(false);
    expect(handle.status.entries.every(entry => entry.preview === "failed" && entry.message === "WebGL")).toBe(true);
    expect(await handle.enter("pair-photo")).toMatchObject({ ok: false, reason: "unavailable" });
  });
});
