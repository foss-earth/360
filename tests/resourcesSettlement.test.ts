import { expect, it, vi } from "vitest";
import { createImageSessionBroker, createImageSourceCache } from "@foss-earth/images";
import { createImageFileService } from "@foss-earth/images/browser";
import { createViewerResources, type ComposedImageSource, type ViewerResourceCompositionPorts } from "../src/resources.js";
import type { CubeRepresentationRecord } from "@foss-earth/sphere-cubemap";
import { deferred, flush, image } from "./fixtures/viewer.js";
it("retains the actual common decoder input after resource retirement and releases a late bitmap", async () => {
  const broker = createImageSessionBroker({ requests: 1, decodes: 1, pools: { sourceGpu: 1e6, decoded: 1e6, encoded: 1e6, overlap: 1e6, uploadOutstanding: 1e6 } });
  const cache = createImageSourceCache<ComposedImageSource>({ broker, keptGpuBytes: 0, gpuBytes: r => r.gpuBytes });
  const gate = deferred<ImageBitmap>(), started = deferred<void>(), close = vi.fn();
  const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,0,0,0,0]);
  const files = createImageFileService({ broker, priority: () => 0, limits: () => ({ responseBytes: 1000, timeoutMs: 1000 }),
    fetch: async () => new Response(png, { headers: { "content-type": "image/png" } }), decode: () => { started.resolve(); return gate.promise; } });
  const record: CubeRepresentationRecord = { id: "preview", projection: "cube", role: "preview", mimeType: "image/png", encodedBytes: png.length * 6, faceSize: 1,
    faces: { px: "https://fixture.invalid/px", nx: "https://fixture.invalid/nx", py: "https://fixture.invalid/py", ny: "https://fixture.invalid/ny", pz: "https://fixture.invalid/pz", nz: "https://fixture.invalid/nz" } };
  const upload = vi.fn(async () => { throw new Error("Cancelled input must never upload"); });
  const ports: ViewerResourceCompositionPorts = { broker, cache, files, atlasDevice: {} as never,
    uploader: { upload, pump: () => 0, busy: () => false, stats: () => ({ queuedJobs: 0, outstandingBytes: 0, uploadedBytes: 0, lastFrameBytes: 0, publishedCompletionFailures: 0, lastPublishedCompletionFailure: null }), setLimits() {}, cancelAll() {} },
    previewSheetsEnabled: () => false, maxTextureSide: () => 4096, whenReady: async () => {}, estimate: () => ({ encoded: 198, decoded: 24, sourceGpu: 24, uploadOutstanding: 24 }),
    choice: { preview: () => ({ representation: record, limitation: null }), immersion: () => null, faceTexels: () => 1 },
    tiles: { memoryBytes: () => 4096, limits: () => ({ requests: 1, waiting: 1, decodes: 1, uploadsPerFrame: 1, retries: 0, retryDelayMs: 1, fadeMs: 0 }), selection: () => ({ levelCap: 0, marginDeg: 0, texelsPerPixel: 1 }), outlines: () => false }, devicePixelsPerCss: () => 1, requestRender() {} };
  const resources = createViewerResources(ports), input = image(); input.asset.representations = [record];
  const loading = resources.acquire(input, resources.preview(input, null)!, { signal: new AbortController().signal, priority: 0, overlap: false }).catch(error => error);
  await started.promise; resources.retire(); cache.dispose(); let done = false;
  const retirement = resources.whenSettled().then(() => { done = true; }); await flush(); expect(done).toBe(false); expect(close).not.toHaveBeenCalled();
  gate.resolve({ width: 1, height: 1, close } as unknown as ImageBitmap); await loading; await retirement;
  expect(close).toHaveBeenCalledOnce(); expect(upload).not.toHaveBeenCalled(); expect(broker.pools.live()).toEqual([]); broker.dispose();
});
