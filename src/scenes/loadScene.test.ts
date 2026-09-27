// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BaseTexture } from "@babylonjs/core";
import { createNavigationOwner, type NavigationPresentation, type NavigationSnapshot } from "../engine/babylon/navigationLease";
import type { PanoramaCameraFrame, PanoramaOrb } from "../engine/babylon/panorama/panoramaRenderer";
import type { PanoramaGpuTexture } from "../engine/babylon/panorama/panoramaTextures";
import { createSettingsRegistry } from "../settings/registry";
import { FOSS_EARTH_PARAMETERS } from "../settings/catalogue";
import { loadScene, type SceneHandle, type SceneRenderer, type SceneRuntime } from "./loadScene";
import { createMemorySceneHistory } from "./sceneHistory";
import { enuFrame, geodeticPoint, scale, add, type Vec3 } from "./panoramaMath";
import type { ResourceBackend } from "./panoramaResources";

const GROUND = 250;
const MANIFEST_URL = "https://foss-earth.test/examples/panorama-scenes/campus-pair.scene.json";
// jsdom's import.meta.url is not a file URL; tests run from the repository root.
const PUBLIC = path.join(process.cwd(), "public");
const manifest = JSON.parse(readFileSync(path.join(PUBLIC, "examples/panorama-scenes/campus-pair.scene.json"), "utf8")) as Record<string, unknown>;

function harness(options: { available?: boolean; groundReady?: boolean } = {}) {
  let clock = 0;
  const frameCallbacks = new Set<() => void>();
  const tick = (ms = 16) => { clock += ms; for (const callback of [...frameCallbacks]) callback(); };
  let groundReady = options.groundReady ?? true;
  let presentation: NavigationPresentation | null = null;
  let continuous = 0;
  const restored: NavigationSnapshot[] = [];
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
    getPresentationView: () => owner.current()?.getPresentationView() ?? null,
    setNavigationIntentHandler: () => () => {},
    requestRender: () => {},
    beginContinuous: () => { continuous += 1; },
    endContinuous: () => { continuous -= 1; },
    onDeviceLost: listener => { deviceLost.add(listener); return () => deviceLost.delete(listener); },
    onDeviceRestored: () => () => {},
    prepareTerrain: async () => ({ groundHeightMeters: GROUND, altitudeMeters: GROUND }),
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
  const backend: ResourceBackend<PanoramaGpuTexture> = {
    async fetch(url) {
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
    baseUrl: MANIFEST_URL, settings, history,
    internals: {
      renderer, backend, now: () => clock, reducedMotion: () => reduced,
      onFrame: callback => { frameCallbacks.add(callback); return () => frameCallbacks.delete(callback); },
    },
  });
  return {
    load, tick, runtime, owner, orbs, shown, restored, textures, history,
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
    const h = harness({ groundReady: false });
    const handle = await loaded(h);
    handles.push(handle);
    expect(handle.status.entries.map(entry => entry.placement)).toEqual(["pending", "pending"]);
    expect(handle.status.overview).toBe("pending");
    expect(h.restored).toHaveLength(0);
    h.setGround(true);
    await settle(h, 2);
    expect(handle.status.entries.map(entry => entry.placement)).toEqual(["placed", "placed"]);
    expect(handle.status.entries.every(entry => entry.preview === "ready")).toBe(true);
    expect(handle.status.overview).toBe("applied");
    expect(h.restored).toHaveLength(1);
    expect(h.orbs.get("pair-photo")!.state.marker).not.toBeNull();
  });

  it("enters through an expanding reveal, hands off with the camera's own view, and exits to the overview it left", async () => {
    const h = harness();
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
    expect(await handle.enter("pair-photo")).toMatchObject({ ok: false, reason: "unavailable" });
  });
});
