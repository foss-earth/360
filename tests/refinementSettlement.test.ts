import { setImmediate } from "node:timers";
import { describe, expect, it } from "vitest";
import {
  createImageSessionBroker, createImageSourceCache,
  type CachedImageSource, type ImageOperationScope, type ImageRepresentation, type Reservation,
} from "@foss-earth/images";
import type { ViewerSource } from "../src/viewer.js";
import { deferred, fixture, image, representation } from "./fixtures/viewer.js";

interface SettlementResource extends CachedImageSource {
  readonly representation: ImageRepresentation;
  readonly source: ViewerSource["source"];
  readonly gpuBytes: number;
  isCurrent(): boolean;
}
const leaves = (error: unknown): unknown[] => error instanceof AggregateError
  ? Array.from(error.errors).flatMap(leaves) : [error];

function settlementFixture() {
  const f = fixture();
  const broker = createImageSessionBroker({ requests: 1, decodes: 1,
    pools: { encoded: 1024, decoded: 1024, sourceGpu: 1024, overlap: 1024, uploadOutstanding: 1024 } });
  const cache = createImageSourceCache<SettlementResource>({ broker, keptGpuBytes: 0, gpuBytes: value => value.gpuBytes });
  const preview = representation("preview-24"), whole = representation("whole-64");
  const tiles: ImageRepresentation = { ...representation("tiles-128"), projection: "tiled-cube" };
  const placed = image("settlement");
  placed.asset = { ...placed.asset, representations: [preview, whole, tiles] };
  const scopes = new Map<string, ImageOperationScope>(), grants = new Map<string, Reservation>();
  const textures = new Map<string, ViewerSource["source"]["texture"]>();
  const disposed = new Map<string, number>(), released = new Map<string, number>(), settled = new Map<string, number>();
  const events: string[] = [], failures: unknown[] = [], failed = deferred<unknown>(), wholePublished = deferred<void>();
  const outgoingError = new Error("outgoing wrapper after actual cache release");
  const settlementError = new Error("incoming wrapper after actual grant settlement");
  const publicationError = new Error("incoming final show");
  const restorationError = new Error("outgoing restoration show");
  const incomingReleaseError = new Error("incoming wrapper after actual private cache release");
  let desired = whole, throwOutgoing = false, throwSettlement = false, throwPublication = false;
  let drawn: ViewerSource["source"]["texture"] | null = null;
  const bump = (map: Map<string, number>, id: string): void => { map.set(id, (map.get(id) ?? 0) + 1); };
  Object.assign(f.options.resources, {
    preview: () => ({ representation: preview, limitation: null }),
    immersion: () => ({ representation: desired, limitation: null }),
    async acquire(_input: unknown, choice: { representation: ImageRepresentation }, request: { signal: AbortSignal; priority: number; overlap: boolean }): Promise<ViewerSource> {
      const record = choice.representation, bytes = record.id === preview.id ? 24 : record.id === whole.id ? 64 : 128;
      const held = await cache.acquire(record.id, { ...request, estimatedGpuBytes: bytes, async load(scope, policy) {
        const grant = scope.reserve("sourceGpu", bytes, record.id, { overlap: policy.overlap });
        scopes.set(record.id, scope); grants.set(record.id, grant);
        const texture = { label: record.id } as never; textures.set(record.id, texture);
        let ended = false;
        return {
          representation: record, gpuBytes: bytes,
          source: { texture, kind: record.id === tiles.id ? "tiles" : "cube" },
          isCurrent: () => scope.isCurrent(),
          dispose() { if (ended) return; ended = true; bump(disposed, record.id); events.push(`${record.id}:dispose`); },
          settleReplacement() {
            grant.settle(); bump(settled, record.id); events.push(`${record.id}:settle`);
            if (record.id === tiles.id && throwSettlement) throw settlementError;
          },
        } satisfies SettlementResource;
      } });
      let ended = false;
      return { representation: record, source: held.resource.source, isCurrent: held.resource.isCurrent,
        viewReady: () => true,
        release() {
          if (ended) return; ended = true; held.release(); bump(released, record.id); events.push(`${record.id}:release`);
          if (record.id === whole.id && throwOutgoing) throw outgoingError;
          if (record.id === tiles.id && throwPublication) throw incomingReleaseError;
        },
        settleReplacement: () => held.settleReplacement() };
    },
  });
  // Read the actual cached output identity, never infer it from a representation ID.
  const scopesTexture = (id: string): ViewerSource["source"]["texture"] | undefined => textures.get(id);
  f.options.renderer.immersion.show = next => {
    if (throwPublication && next && !next.next) {
      if (next.source.texture === scopesTexture(tiles.id)) { events.push("incoming:show-throw"); throw publicationError; }
      if (next.source.texture === scopesTexture(whole.id)) { events.push("outgoing:restore-throw"); throw restorationError; }
    }
    drawn = next?.source.texture ?? null;
  };
  f.options.failure = (_input, kind, error) => { if (kind === "image") { failures.push(error); failed.resolve(error); } };
  const off = f.viewer.subscribe(() => { if (f.viewer.currentSources(placed.id).shown === whole.id) wholePublished.resolve(); });
  return { ...f, broker, cache, preview, whole, tiles, placed, scopes, grants, disposed, released, settled, events, failures, failed,
    errors: { outgoingError, settlementError, publicationError, restorationError, incomingReleaseError },
    drawn: () => drawn, texture: scopesTexture,
    async open() {
      const prepared = await f.viewer.prepare(placed, new AbortController().signal); await prepared.ready(); f.viewer.replaceImages([prepared]);
      expect(await f.viewer.enter(placed.id)).toBe(true); await wholePublished.promise;
      // A host turn follows the actual publication, letting that refinement's
      // promise finalizer finish before the next explicitly supplied host frame.
      await new Promise<void>(resolve => setImmediate(resolve)); events.length = 0;
    },
    publishWithCleanupFailures() { throwOutgoing = true; throwSettlement = true; desired = tiles; f.viewer.onFrame({ now: 0, dtMs: 0 }); },
    rejectBeforePublication() { throwPublication = true; desired = tiles; f.viewer.onFrame({ now: 0, dtMs: 0 }); },
    cleanup() { off(); f.viewer.dispose(); cache.dispose(); broker.dispose(); },
  };
}

describe("refinement settlement with actual common ownership", () => {
  it("retains the displayed incoming cache hold when outgoing release and incoming settlement throw", async () => {
    const f = settlementFixture();
    try {
      await f.open(); expect(f.broker.pools.stats().sourceGpu.reserved).toBe(88); expect(f.cache.stats().heldReferences).toBe(2);
      f.publishWithCleanupFailures(); const failure = await f.failed.promise;
      expect(leaves(failure)).toEqual([f.errors.outgoingError, f.errors.settlementError]);
      expect(f.events).toEqual(["whole-64:dispose", "whole-64:release", "tiles-128:settle"]);
      expect(f.viewer.currentSources(f.placed.id)).toEqual({ preview: f.preview.id, shown: f.tiles.id });
      expect(f.drawn()).toBe(f.texture(f.tiles.id)); expect(f.scopes.get(f.tiles.id)!.isCurrent()).toBe(true);
      expect(f.scopes.get(f.whole.id)!.isCurrent()).toBe(false); expect(f.grants.get(f.whole.id)!.released).toBe(true);
      expect(f.disposed.get(f.whole.id)).toBe(1); expect(f.disposed.get(f.tiles.id) ?? 0).toBe(0);
      expect(f.released.get(f.whole.id)).toBe(1); expect(f.released.get(f.tiles.id) ?? 0).toBe(0); expect(f.settled.get(f.tiles.id)).toBe(1);
      expect(f.cache.stats().heldReferences).toBe(2); expect(f.broker.pools.stats().sourceGpu.reserved).toBe(152); expect(f.broker.pools.stats().overlap.reserved).toBe(0);
      expect(f.broker.pools.live().map(grant => [grant.label, grant.bytes, grant.overlap])).toEqual([[f.preview.id, 24, false], [f.tiles.id, 128, false]]);
      expect(f.holds.active).toBe(0); expect(f.failures).toEqual([failure]);
    } finally { f.cleanup(); }
    expect(f.disposed.get(f.preview.id)).toBe(1); expect(f.disposed.get(f.whole.id)).toBe(1); expect(f.disposed.get(f.tiles.id)).toBe(1);
    expect(f.cache.stats().heldReferences).toBe(0); expect(f.broker.pools.live()).toEqual([]); expect(f.holds.active).toBe(0);
  });

  it("attempts private incoming release after final show and restoration both throw, preserving causal order", async () => {
    const f = settlementFixture();
    try {
      await f.open(); f.rejectBeforePublication(); const failure = await f.failed.promise;
      expect(leaves(failure)).toEqual([f.errors.publicationError, f.errors.restorationError, f.errors.incomingReleaseError]);
      expect(f.events).toEqual(["incoming:show-throw", "outgoing:restore-throw", "tiles-128:dispose", "tiles-128:release"]);
      expect(f.viewer.currentSources(f.placed.id)).toEqual({ preview: f.preview.id, shown: f.whole.id });
      expect(f.drawn()).toBe(f.texture(f.whole.id)); expect(f.scopes.get(f.whole.id)!.isCurrent()).toBe(true); expect(f.scopes.get(f.tiles.id)!.isCurrent()).toBe(false);
      expect(f.grants.get(f.tiles.id)!.released).toBe(true); expect(f.disposed.get(f.tiles.id)).toBe(1); expect(f.released.get(f.tiles.id)).toBe(1); expect(f.settled.get(f.tiles.id) ?? 0).toBe(0);
      expect(f.disposed.get(f.whole.id) ?? 0).toBe(0); expect(f.released.get(f.whole.id) ?? 0).toBe(0);
      expect(f.cache.stats().heldReferences).toBe(2); expect(f.broker.pools.stats().sourceGpu.reserved).toBe(88); expect(f.broker.pools.stats().overlap.reserved).toBe(0);
      expect(f.broker.pools.live().map(grant => [grant.label, grant.bytes, grant.overlap])).toEqual([[f.preview.id, 24, false], [f.whole.id, 64, false]]);
      expect(f.holds.active).toBe(0); expect(f.failures).toEqual([failure]);
    } finally { f.cleanup(); }
    expect(f.disposed.get(f.preview.id)).toBe(1); expect(f.disposed.get(f.whole.id)).toBe(1); expect(f.disposed.get(f.tiles.id)).toBe(1);
    expect(f.cache.stats().heldReferences).toBe(0); expect(f.broker.pools.live()).toEqual([]); expect(f.holds.active).toBe(0);
  });
});
