import { expect, it, vi } from "vitest";
import { fixture, deferred, flush, image, source } from "./fixtures/viewer.js";
import type { ViewerSource } from "../src/viewer.js";
it("settles a cancelled late preview only after the actual source arrives and is released", async () => {
  const f = fixture(), gate = deferred<ViewerSource>(); f.acquire.mockImplementationOnce(() => gate.promise);
  const handle = await f.viewer.prepare(image(), new AbortController().signal), ready = handle.ready().catch(error => error);
  await flush(); f.viewer.dispose(); let done = false;
  const retirement = f.viewer.whenSettled().then(() => { done = true; }); await flush(); expect(done).toBe(false);
  const late = source(); gate.resolve(late); await ready; await retirement;
  expect(late.release).toHaveBeenCalledOnce(); expect(f.viewer.status().phase).toBe("disposed"); expect(f.holds.active).toBe(0);
});
it("attempts every orb cleanup even when the first one throws, and exposes retirement failure", async () => {
  const f = fixture(); await f.viewer.prepare(image("a"), new AbortController().signal); await f.viewer.prepare(image("b"), new AbortController().signal);
  const cleanup = new Error("orb cleanup");
  f.orbs[0].dispose.mockImplementation(() => { throw cleanup; });
  let failure: unknown;
  try { f.viewer.dispose(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  const preparedFailure = (failure as AggregateError).errors[0] as AggregateError;
  expect(preparedFailure).toBeInstanceOf(AggregateError); expect(preparedFailure.errors).toContain(cleanup);
  expect(f.orbs[1].dispose).toHaveBeenCalledOnce();
  await expect(f.viewer.whenSettled()).rejects.toThrow("retirement");
});
it("starts actual viewer cancellation on the injected host signal", async () => {
  const f = fixture(), host = new AbortController(); f.viewer.dispose();
  const { createImageViewer } = await import("../src/viewer.js");
  const viewer = createImageViewer({ ...f.options, signal: host.signal, onRetirementError: vi.fn() });
  host.abort(); expect(viewer.status().phase).toBe("disposed"); await viewer.whenSettled();
});
