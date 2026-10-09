import { describe, expect, it, vi } from "vitest";
import { createImageSessionBroker, createImageSourceCache, type ImageOperationScope } from "@foss-earth/images";
import type { ViewerSource } from "../src/viewer.js";
import { deferred, fixture, flush, image, representation, source } from "./fixtures/viewer.js";

function warmingFixture(pending=false){
  const f=fixture(),broker=createImageSessionBroker({requests:1,decodes:1,pools:{encoded:1024,decoded:1024,sourceGpu:1024,overlap:1024,uploadOutstanding:1024}});
  const record={...representation("tiles"),projection:"tiled-cube"};
  const ready=deferred<void>(),dispose=vi.fn(),tick=vi.fn(()=>false);let allocations=0,scope:ImageOperationScope|null=null;
  type Cached=Omit<ViewerSource,"release">&{gpuBytes:number;dispose():void};
  const cache=createImageSourceCache<Cached>({broker,keptGpuBytes:0,gpuBytes:value=>value.gpuBytes});
  f.options.resources.warm=()=>({representation:record,limitation:null,key:"tiles@v1"});
  f.options.resources.immersion=()=>({representation:record,limitation:null,key:"tiles@v1"});
  const acquire=vi.fn(async(_input:Parameters<typeof f.options.resources.acquire>[0],choice:Parameters<typeof f.options.resources.acquire>[1],request:Parameters<typeof f.options.resources.acquire>[2]):Promise<ViewerSource>=>{
    if(choice.representation.projection!=="tiled-cube")return source(choice.representation.id);
    const held=await cache.acquire("tiles@v1",{...request,estimatedGpuBytes:128,async load(operation,policy){
      scope=operation;const grant=operation.reserve("sourceGpu",128,"warming fixture allocation",{overlap:policy.overlap});
      // The fixture allocation exists across an unabortable factory wait.
      // Keep its real grant until its actual late-output disposal, not abort.
      const keep=grant.retain();allocations++;let ended=false;
      const resource:Cached={representation:record,key:"tiles@v1",source:{texture:{} as never,kind:"tiles"},gpuBytes:128,isCurrent:()=>operation.isCurrent(),onFrame:tick,
        settleReplacement:()=>grant.settle(),dispose(){if(ended)return;ended=true;dispose();try{keep();}finally{grant.release();}}};
      if(pending)await ready.promise;
      return resource;
    }});
    return{...held.resource,release:()=>held.release(),settleReplacement:()=>held.settleReplacement()};
  });
  f.options.resources.acquire=acquire;
  const frame=f.options.renderer.cameraFrame;
  const camera=vi.fn((view?:Parameters<typeof frame>[0])=>frame(view));f.options.renderer.cameraFrame=camera;
  const poses=f.options.poses.presentationFromView;
  const presentation=vi.fn(poses);f.options.poses.presentationFromView=presentation;
  return{...f,broker,cache,ready,dispose,tick,acquire,camera,presentation,allocations:()=>allocations,scope:()=>scope,
    cleanup(){f.viewer.dispose();cache.dispose();broker.dispose();}};
}

describe("entry tile warming on the existing host frame",()=>{
  it("does not acquire a non-tiled result from a foreign warming selector",async()=>{
    const f=fixture();f.options.resources.warm=()=>({representation:representation("detail"),limitation:null});
    const handle=await f.viewer.prepare(image(),new AbortController().signal);await handle.ready();f.viewer.replaceImages([handle]);
    expect(await f.viewer.enter("a")).toBe(true);await flush();
    expect(f.acquire.mock.calls.every(call=>call[1].representation.id==="preview-64")).toBe(true);f.viewer.dispose();expect(f.holds.active).toBe(0);
  });
  it.each(["flight","expansion"] as const)("uses the %s virtual opening view, then transfers its one ready allocation into immersion",async mode=>{
    const f=warmingFixture(),input=image();input.placement.marker=[6378147,0,0];
    const handle=await f.viewer.prepare(input,new AbortController().signal);await handle.ready();f.viewer.replaceImages([handle]);
    f.settings.expandDurationMs=100;f.settings.flightDurationMs=mode==="flight"?100:0;
    const view={headingDeg:123,pitchDeg:7,verticalFovDeg:55},entering=f.viewer.enter("a",{view});await flush();
    expect(f.viewer.status().phase).toBe("entering");expect(f.viewer.isPlacementFrozen("a")).toBe(true);
    expect(f.viewer.currentSources("a")).toEqual({preview:"preview-64",shown:null});
    const warmingCall=f.acquire.mock.calls.find(call=>call[1].representation.projection==="tiled-cube")!;
    expect(warmingCall[2].priority).toBe(5);expect(warmingCall[2].overlap).toBe(true);expect(f.allocations()).toBe(1);
    const opening=f.presentation.mock.calls.find(call=>call[1].headingDeg===123&&call[1].pitchDeg===7)!,virtual=f.presentation.mock.results[f.presentation.mock.calls.indexOf(opening)].value;
    await f.advance(40);expect(f.camera).toHaveBeenCalledWith(virtual);expect(f.tick).toHaveBeenCalled();expect(f.holds.active).toBe(1);
    await f.advance(60);expect(await entering).toBe(true);await flush();
    expect(f.viewer.currentSources("a")).toEqual({preview:"preview-64",shown:"tiles"});
    expect(f.acquire.mock.calls.filter(call=>call[1].representation.projection==="tiled-cube")).toHaveLength(1);
    expect(f.allocations()).toBe(1);expect(f.cache.stats().heldReferences).toBe(1);expect(f.broker.pools.stats().overlap.reserved).toBe(0);
    f.cleanup();expect(f.dispose).toHaveBeenCalledTimes(1);expect(f.broker.pools.live()).toEqual([]);expect(f.holds.active).toBe(0);
  });
  it("joins a pending common cache load before releasing the warming waiter",async()=>{
    const f=warmingFixture(true),handle=await f.viewer.prepare(image(),new AbortController().signal);await handle.ready();f.viewer.replaceImages([handle]);
    expect(await f.viewer.enter("a")).toBe(true);await flush();
    expect(f.viewer.currentSources("a")).toEqual({preview:"preview-64",shown:"preview-64"});
    const calls=f.acquire.mock.calls.filter(call=>call[1].representation.projection==="tiled-cube");
    expect(calls.map(call=>call[2].priority)).toEqual([5,10]);expect(calls[0][2].signal.aborted).toBe(true);
    expect(f.scope()!.isCurrent()).toBe(true);expect(f.cache.stats().waiting).toBe(1);expect(f.allocations()).toBe(1);
    f.ready.resolve();await flush();expect(f.viewer.currentSources("a").shown).toBe("tiles");expect(f.cache.stats().heldReferences).toBe(1);
    f.cleanup();expect(f.dispose).toHaveBeenCalledTimes(1);expect(f.broker.pools.live()).toEqual([]);expect(f.holds.active).toBe(0);
  });
  it("releases a cancelled entry's warming and retires its actual unabortable late allocation",async()=>{
    const f=warmingFixture(true),input=image();input.placement.marker=[6378147,0,0];
    const handle=await f.viewer.prepare(input,new AbortController().signal);await handle.ready();f.viewer.replaceImages([handle]);f.settings.expandDurationMs=100;
    const entering=f.viewer.enter("a");await flush();expect(f.allocations()).toBe(1);
    f.cancelControllers.at(-1)!.abort(new Error("fresh host input"));await flush();expect(await entering).toBe(false);
    expect(f.scope()!.isCurrent()).toBe(false);expect(f.dispose).not.toHaveBeenCalled();expect(f.broker.pools.stats().sourceGpu.reserved).toBe(128);
    expect(f.viewer.currentSources("a")).toEqual({preview:"preview-64",shown:null});
    f.ready.resolve();await flush();expect(f.dispose).toHaveBeenCalledTimes(1);expect(f.broker.pools.stats().sourceGpu.reserved).toBe(0);
    f.cleanup();expect(f.broker.pools.live()).toEqual([]);expect(f.holds.active).toBe(0);
  });
});
