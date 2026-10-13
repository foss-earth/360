import { vi } from "vitest";
import type { ImageRepresentation } from "@foss-earth/images";
import { createImageViewer, type ImageViewerOptions, type ViewerNavigationLease, type ViewerSettings, type ViewerSource } from "../../src/viewer.js";
import type { ViewerImageInput } from "../../src/index.js";
import type { OrbState, OrbExpansion } from "../../src/renderer.js";
import { world } from "./world.js";

export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function flush(): Promise<void> { for (let n = 0; n < 20; n++) await Promise.resolve(); }
export const representation = (id: string): ImageRepresentation => ({ id, role: id.startsWith("preview") ? "preview" : "immersion", projection: "cube", mimeType: "image/png", encodedBytes: 60 });
export const image = (id = "a"): ViewerImageInput => ({
  id, title: `Image ${id}`, asset: { id: `asset-${id}`, revision: "v1", type: "panorama-image", colorSpace: "srgb", alpha: "opaque", attribution: { text: "Fixture photographer" }, representations: [representation("preview-64"), representation("detail")] },
  pose: { headingDeg: 0, pitchDeg: 0, rollDeg: 0 }, placement: { marker: null, radiusMeters: 1, content: [[1,0,0],[0,1,0],[0,0,1]], outline: null, hoverScale: 1.2 },
  credits: { text: "Fixture photographer" }, actions: [],
});
export function source(id = "preview-64"): ViewerSource {
  return { representation: representation(id), source: { texture: { label: id } as never, kind: "cube" }, release: vi.fn(), settleReplacement: vi.fn() };
}
export function fixture() {
  let now = 0;
  const settings: ViewerSettings = { appearance: { previewFovDeg: 90, markerDiameterCssPx: { min: 24, max: 96 }, hitTargetDiameterCssPx: 44 }, look: { dragSensitivity: .15, swipeSensitivity: .15, lookRate: 90, zoomPerNotch: .1, zoomRate: .5, pinchGain: 1, inertiaHalfLifeMs: 100, fovRangeDeg: { min: 35, max: 90 }, pitchRangeDeg: { min: -85, max: 85 }, reducedMotion: false }, entryOrientation: "geographic", flightDurationMs: 0, expandDurationMs: 0, fadeDurationMs: 0, reducedFadeDurationMs: 0, orientDurationMs: 0, hoverDurationMs: 0, previewHoldMs: 10000 };
  const orbs: { id: string; state: OrbState; expansion: OrbExpansion | null; dispose: ReturnType<typeof vi.fn> }[] = [];
  const render = vi.fn(), holds = { active: 0 };
  const hold = () => { holds.active++; let released = false; return () => { if (!released) { released = true; holds.active--; } }; };
  const abort = new AbortController();
  const lease: ViewerNavigationLease = { overview: { version: 1, view: { lonDeg: 0, latDeg: 0, headingDeg: 0, pitchDeg: 0, zoomMeters: 100 }, camera: { center: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: Math.PI/2, radius: 100, fov: Math.PI/3 } }, signal: abort.signal, released: false,
    setPresentationView: vi.fn(), holdRendering: hold, release: vi.fn(() => { Object.defineProperty(lease, "released", { value: true }); abort.abort(); }) };
  const preview = vi.fn((input: ViewerImageInput) => ({ representation: input.asset.representations[0], limitation: null }));
  const acquire = vi.fn(async (_input: ViewerImageInput, choice: { representation: ImageRepresentation }) => source(choice.representation.id));
  const immersion = vi.fn((): { representation: ImageRepresentation; limitation: null } | null => null);
  const detach = vi.fn();
  const cancelControllers: AbortController[] = [];
  let acquired=0;
  const freshLease=():ViewerNavigationLease=>{
    const signal=new AbortController();const value:ViewerNavigationLease={...lease,signal:signal.signal,released:false,setPresentationView:vi.fn(),release:vi.fn(()=>{Object.defineProperty(value,"released",{value:true});signal.abort();})};return value;
  };
  const options: ImageViewerOptions = {
    renderer: { available: true, unavailableReason: null, addOrb(id, initial) { const value = { id, state: initial, expansion: null as OrbExpansion | null, dispose: vi.fn() }; orbs.push(value); return { id, update(state) { value.state = { ...value.state, ...state }; }, setExpansion(next) { value.expansion = next; }, effectiveRadius: () => value.state.radiusMeters, dispose: value.dispose }; }, immersion: { show: vi.fn(), setOpacity: vi.fn(), replaceContent: vi.fn(), visible: false }, setAppearance: vi.fn(() => render()), cameraFrame: () => ({ eye: [6378147,-100,0], view: { forward: [0,1,0], right: [0,0,-1], up: [1,0,0], verticalFovRad: Math.PI/3, aspect: 1.6 }, viewportHeightCssPx: 900, revision: "fixture", viewRotProj: {} as never, inverseViewRotProj: {} as never }), pick: () => [], project: () => null },
    resources: { preview, immersion, acquire, faceTexels: () => 64 }, world,
    poses: { viewFromPresentation: () => ({ headingDeg: 0, pitchDeg: 0, rollDeg: 0, verticalFovDeg: 60 }), presentationFromView: () => ({ position: { x: 1,y: 0,z: 0 }, forward: { x: 0,y: 1,z: 0 }, up: { x: 1,y: 0,z: 0 }, verticalFovRad: Math.PI/3 }) },
    navigation: { acquire: () => ({ ok: true, lease: acquired++===0?lease:freshLease() }), place: vi.fn(), restore: vi.fn(), glide: vi.fn(), inertiaDecay: () => .82, returnFocus: vi.fn() },
    input: { cancelOnInput(controller) { cancelControllers.push(controller); return { stop: vi.fn(), press: () => null }; }, attach: () => ({ detach }) },
    settings: () => settings, now: () => now, devicePixelsPerCss: () => 1, createAbortController: () => new AbortController(), requestRender: render, holdRendering: hold, isOccluded: () => false,
  };
  const viewer = createImageViewer(options);
  return { viewer, options, settings, orbs, preview, acquire, immersion, detach, cancelControllers, lease, abort, holds, render,
    async advance(ms: number) { now += ms; viewer.onFrame({ now, dtMs: ms }); await flush(); } };
}
