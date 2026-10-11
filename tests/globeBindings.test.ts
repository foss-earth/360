// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createGlobeViewerFrameBinding, createGlobeViewerNavigation, createGlobeViewerProjection, createViewerSceneDescription,
  type GlobeViewerRuntime, type ViewerSceneDescriptionPorts } from "../src/globeBindings.js";
import { createGlobeViewerInput } from "../src/globeBrowserBindings.js";
import { image, fixture } from "./fixtures/viewer.js";
import type { ViewerNavigationLease } from "../src/viewer.js";
import { createBuiltInRepresentations } from "../src/catalogue.js";
const description: ViewerSceneDescriptionPorts = { representations: createBuiltInRepresentations(() => ({ tileMemoryBytes: 4096, responseBytes: 4096, requests: 1, waiting: 1, uploadOutstandingBytes: 4096 })), tileMemoryBytes: () => 4096, maxTextureSide: () => 4096 };
it("keeps the actual native lease and refuses another host's lease while returning original focus", () => {
  const f = fixture(), focus = {}, native = { ...f.lease, focusReturn: focus }, acquire = vi.fn(() => ({ ok: true, lease: native })), place = vi.fn(), glide = vi.fn(), returnFocus = vi.fn();
  const runtime = { acquireNavigation: acquire, placeNavigationCamera: place, restoreNavigationSnapshot: vi.fn(), glideNavigationCamera: glide,
    getCameraHandling: () => ({ glideKeepPerFrame: .82 }) } as unknown as GlobeViewerRuntime;
  const binding = createGlobeViewerNavigation(runtime, { isAbortSignal: (s): s is AbortSignal => s instanceof AbortSignal, returnFocus });
  const got = binding.navigation.acquire(); expect(got.ok).toBe(true); if (!got.ok) throw new Error("fixture lease refused");
  expect(got.lease.signal).toBe(native.signal); expect(binding.engineLeaseFor(got.lease)).toBe(native);
  binding.navigation.returnFocus(got.lease); expect(returnFocus).toHaveBeenCalledWith(focus);
  expect(() => binding.navigation.place({ ...got.lease } as ViewerNavigationLease, {} as never)).toThrow("another host");
  f.viewer.dispose();
});
it("feeds the real panorama projection a geographic view and reuses the borrowed frame", () => {
  const f = fixture(), input = image(); input.details = { capture: { longitudeDeg: 0, latitudeDeg: 0 } } as typeof input.details;
  const project = vi.fn(() => ({ x: 11, y: 22 })), frame = {} as never;
  const projection = createGlobeViewerProjection({ viewer: { ...f.viewer, status: () => ({ ...f.viewer.status(), active: "a" }), describeImage: () => input },
    renderer: { cameraFrame: () => frame, project }, runtime: { getPresentationView: () => null } });
  expect(projection({ headingDeg: 90, pitchDeg: 0 })).toEqual({ x: 11, y: 22 });
  expect(project.mock.calls[0][0].every(Number.isFinite)).toBe(true); expect(project.mock.calls[0][1]).toBe(frame); f.viewer.dispose();
});
it("supplies typed scene readings using real format owner dimensions/costs, independent of placements", () => {
  const f = fixture(), input = image();
  input.asset.representations = [{ ...input.asset.representations[0], faceSize: 1, faces: { px: "a", nx: "b", py: "c", ny: "d", pz: "e", nz: "f" } }];
  const describe = createViewerSceneDescription({ ...f.viewer, describeImage: () => input }, description), result = describe("a");
  expect(result.images[0]).toMatchObject({ width: 1, height: 1, aroundPx: 4, gpuBytes: 24, encodedBytes: 60 });
  expect(result.previewDetail).toBeNull(); f.viewer.dispose();
});
it("calls onFrame once through existing preparation and never owns another subscription or paint loop", () => {
  const f = fixture(), onFrame = vi.fn(() => true), requestRender = vi.fn(), subscribe = vi.fn(() => () => {});
  let current = true;
  const binding = createGlobeViewerFrameBinding({ viewer: { ...f.viewer, onFrame }, isCurrent: () => current, requestRender, frames: { subscribe }, description });
  binding.framePreparation.prepare({ nowMs: 20, deltaSeconds: .016 }); expect(onFrame).toHaveBeenCalledExactlyOnceWith({ now: 20, dtMs: 16 });
  expect(requestRender).toHaveBeenCalledOnce(); expect(subscribe).not.toHaveBeenCalled(); current = false;
  binding.framePreparation.prepare({ nowMs: 21, deltaSeconds: .016 }); expect(onFrame).toHaveBeenCalledTimes(1); f.viewer.dispose();
});
it("removes cancellation input handlers on host abort and keeps the held press for handback", () => {
  const canvas = document.createElement("canvas"), host = new AbortController(), cancel = new AbortController(); document.body.append(canvas);
  const binding = createGlobeViewerInput({ getInputMode: () => "mouse", setNavigationIntentHandler: () => () => {} }, canvas, () => { throw new Error("No fixture lease attached"); },
    { nowMs: () => 0, controlTakesKey: () => false, abortReason: () => new Error("input"), signal: host.signal });
  const stop = binding.input.cancelOnInput(cancel);
  const press = new Event("pointerdown"); Object.assign(press, { pointerType: "mouse", pointerId: 1, button: 0, clientX: 2, clientY: 3 }); canvas.dispatchEvent(press);
  expect(cancel.signal.aborted).toBe(true); expect(stop.press()).toMatchObject({ pointerId: 1, clientX: 2 });
  host.abort(); expect(() => binding.input.cancelOnInput(new AbortController())).toThrow("retired"); canvas.remove();
});
