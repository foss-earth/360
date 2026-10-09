import { describe, expect, it, vi } from "vitest";
import { createImageSessionBroker, createImageSourceCache, type ImageSourceCache } from "@foss-earth/images";
import { createImageFileService } from "@foss-earth/images/browser";
import type { CubeRepresentationRecord } from "@foss-earth/cubemap";
import { tileAtlasLayout, type TiledCubeRepresentationRecord } from "@foss-earth/tiled-cubemap";
import { createViewerResources, type ComposedImageSource, type ViewerResourceCompositionPorts } from "../src/resources.js";
import { deferred, fixture, flush, image } from "./fixtures/viewer.js";

function fallbackFixture(keptGpuBytes=1e6){
  const broker=createImageSessionBroker({requests:2,decodes:1,pools:{encoded:1000,decoded:1000,sourceGpu:1e6,overlap:1e6,uploadOutstanding:1000}});
  const cache=createImageSourceCache<ComposedImageSource>({broker,keptGpuBytes,gpuBytes:value=>value.gpuBytes});
  const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,0,0,0,0]);
  const cube=(id:string):CubeRepresentationRecord=>({id,role:"preview",projection:"cube",mimeType:"image/png",encodedBytes:198,faceSize:1,faces:{px:`https://fixture.invalid/${id}/px`,nx:`https://fixture.invalid/${id}/nx`,py:`https://fixture.invalid/${id}/py`,ny:`https://fixture.invalid/${id}/ny`,pz:`https://fixture.invalid/${id}/pz`,nz:`https://fixture.invalid/${id}/nz`}});
  const first=cube("first"),published=cube("published"),privatePreview=cube("private");
  const tiles:TiledCubeRepresentationRecord={id:"tiles",role:"immersion",projection:"tiled-cube",mimeType:"image/png",encodedBytes:126,warp:"gnomonic",faceSize:8,tileSize:2,gutter:0,levelBytes:[6,24,96],url:"https://fixture.invalid/tiles/"};
  const base=image();base.asset={...base.asset,id:"fallback-asset",representations:[first,published,privatePreview,tiles]};
  const reads:string[]=[],textures=new Map<string,unknown>(),events:string[]=[],loadErrors:unknown[]=[];
  const gate=deferred<void>();let pending=false,lateDisposeError:Error|null=null,closeError:Error|null=null,decoded=0,closed=0,atlases=0;
  const files=createImageFileService({broker,priority:()=>0,limits:()=>({responseBytes:1000,timeoutMs:1000}),
    fetch:async url=>{reads.push(String(url));return new Response(png,{headers:{"content-type":"image/png"}});},
    decode:async()=>{const index=decoded++;return{width:1,height:1,close(){closed++;if(index===0&&closeError)throw closeError;}} as ImageBitmap;}});
  const tracked:ImageSourceCache<ComposedImageSource>={...cache,
    acquire(key,request){return cache.acquire(key,{...request,async load(scope,policy){try{return await request.load(scope,policy);}catch(error){loadErrors.push(error);throw error;}}});}};
  let choice=published;
  const ports:ViewerResourceCompositionPorts={broker,cache:tracked,files,atlasDevice:{} as never,
    uploader:{upload:async request=>{if(pending)await gate.promise;const texture={label:request.label};textures.set(request.label,texture);let ended=false;return{kind:"cube",width:1,height:1,levels:1,gpuBytes:24,texture:texture as never,complete:true,dispose(){if(ended)return;ended=true;events.push("cube");if(lateDisposeError)throw lateDisposeError;}};},pump:()=>0,busy:()=>false,setLimits(){},stats:()=>({queuedJobs:0,outstandingBytes:0,lastFrameBytes:0,uploadedBytes:0,publishedCompletionFailures:0,lastPublishedCompletionFailure:null}),cancelAll(){}},
    previewSheetsEnabled:()=>false,maxTextureSide:()=>4096,whenReady:async()=>{},
    estimate:record=>({encoded:0,decoded:0,sourceGpu:record.projection==="tiled-cube"?tileAtlasLayout(record as TiledCubeRepresentationRecord,4096,4096)!.gpuBytes:24,uploadOutstanding:0}),
    choice:{preview:()=>({representation:choice,limitation:null}),immersion:()=>null,faceTexels:()=>1},
    tiles:{memoryBytes:()=>4096,limits:()=>({requests:1,waiting:1,decodes:1,uploadsPerFrame:1,retries:0,retryDelayMs:1,fadeMs:0}),selection:()=>({texelsPerPixel:1,marginDeg:0,levelCap:0}),outlines:()=>false},
    createAtlas:({layout})=>{atlases++;return{layout,atlas:{} as never,table:{} as never,beginUpdate:()=>true,endUpdate(){},uploadTile:()=>true,setTable:()=>true,dispose(){events.push("atlas");}};},devicePixelsPerCss:()=>1,requestRender(){}};
  const resources=createViewerResources(ports),viewerFixture=fixture();Object.assign(viewerFixture.options.resources,resources);
  ports.previewForTiles=input=>{const current=viewerFixture.viewer.describeImage?.(input.id),id=viewerFixture.viewer.currentSources(input.id).preview;return current&&id?{asset:{id:current.asset.id,revision:current.asset.revision},representation:id}:null;};
  return{broker,cache,ports,resources,viewer:viewerFixture.viewer,base,first,published,privatePreview,tiles,reads,textures,events,loadErrors,gate,
    choice:(record:CubeRepresentationRecord)=>{choice=record;},pending:()=>{pending=true;},throwCleanup:(output:Error,input:Error)=>{lateDisposeError=output;closeError=input;},
    closed:()=>closed,atlases:()=>atlases,
    acquire:(input=base)=>resources.acquire(input,{representation:tiles,limitation:null},{signal:new AbortController().signal,priority:5,overlap:true}),
    cleanup(){viewerFixture.viewer.dispose();cache.dispose();broker.dispose();}};
}
const leaves=(error:unknown):unknown[]=>error instanceof AggregateError?Array.from(error.errors).flatMap(leaves):[error];

describe("per-acquisition tiled cube fallback",()=>{
  it("uses actual published preview, excludes private preparation, and reuses an atlas with a new fallback",async()=>{
    const f=fallbackFixture(),handle=await f.viewer.prepare(f.base,new AbortController().signal);await handle.ready();f.viewer.replaceImages([handle]);
    const first=await f.acquire();expect(first.source.texture).toBe(f.textures.get("fallback-asset/published"));expect(f.atlases()).toBe(1);
    expect(f.cache.stats().heldReferences).toBe(3);first.release();expect(f.cache.stats().heldReferences).toBe(1);
    f.choice(f.privatePreview);const hidden=await f.viewer.prepare(f.base,new AbortController().signal);await hidden.ready();
    const privateExcluded=await f.acquire();expect(privateExcluded.source.texture).toBe(first.source.texture);expect(privateExcluded.source.texture).not.toBe(f.textures.get("fallback-asset/private"));privateExcluded.release();hidden.dispose();
    f.choice(f.first);const replacement=await f.viewer.prepare(f.base,new AbortController().signal);await replacement.ready();f.viewer.replaceImages([replacement]);
    const second=await f.acquire();expect(second.source.texture).toBe(f.textures.get("fallback-asset/first"));expect(second.source.texture).not.toBe(first.source.texture);expect(second.source.tiles!.atlas).toBe(first.source.tiles!.atlas);expect(f.atlases()).toBe(1);
    second.release();expect(f.cache.stats().heldReferences).toBe(1);f.viewer.dispose();expect(f.cache.stats().heldReferences).toBe(0);
    expect(f.cache.stats().keptGpuBytes).toBe(tileAtlasLayout(f.tiles,4096,4096)!.gpuBytes+72);
    f.cache.setKeptGpuBytes(0);expect(f.broker.pools.live()).toEqual([]);f.cleanup();
  });
  it.each(["omitted","null","stale-revision","foreign-asset","private-id"])("uses first declared cube for %s published reading without asking a sharper selector",async kind=>{
    const f=fallbackFixture();const sharper=vi.fn(()=>({representation:f.privatePreview,limitation:null}));f.ports.choice.preview=sharper;
    if(kind==="omitted")delete f.ports.previewForTiles;
    else f.ports.previewForTiles=()=>kind==="null"?null:{asset:{id:kind==="foreign-asset"?"elsewhere":f.base.asset.id,revision:kind==="stale-revision"?"v0":f.base.asset.revision},representation:kind==="private-id"?"not-declared":f.published.id};
    const source=await f.acquire();expect(source.source.texture).toBe(f.textures.get("fallback-asset/first"));expect(sharper).not.toHaveBeenCalled();expect(f.reads).toEqual(Object.values(f.first.faces));source.release();expect(f.cache.stats().heldReferences).toBe(0);f.cleanup();expect(f.broker.pools.live()).toEqual([]);
  });
  it("releases both real cache holds in order even when supplied release/settlement wrappers throw",async()=>{
    const f=fallbackFixture(0),original=f.ports.cache,releaseErrors=[new Error("atlas release"),new Error("preview release")],settleErrors=[new Error("atlas settle"),new Error("preview settle")],calls:string[]=[];
    f.ports.cache={...original,async acquire(key,request){const hold=await original.acquire(key,request),tile=hold.resource.representation.projection==="tiled-cube",index=tile?0:1;return{...hold,
      release(){hold.release();calls.push(tile?"atlas release":"preview release");throw releaseErrors[index];},
      settleReplacement(){hold.settleReplacement();calls.push(tile?"atlas settle":"preview settle");throw settleErrors[index];}};}};
    const source=await f.acquire();let settlement:unknown,released:unknown;
    try{source.settleReplacement();}catch(error){settlement=error;}expect(leaves(settlement)).toEqual(settleErrors);expect(f.broker.pools.stats().overlap.reserved).toBe(0);expect(()=>source.settleReplacement()).not.toThrow();
    try{source.release();}catch(error){released=error;}expect(leaves(released)).toEqual(releaseErrors);expect(calls).toEqual(["atlas settle","preview settle","atlas release","preview release"]);
    expect(()=>source.release()).not.toThrow();expect(f.cache.stats().heldReferences).toBe(0);expect(f.broker.pools.live()).toEqual([]);f.cleanup();
  });
  it("cancels both acquisitions but holds real decoded faces until nonabortable late upload cleanup",async()=>{
    const f=fallbackFixture(0),abort=new AbortController(),outputError=new Error("late output disposal"),inputError=new Error("late decoded input close");f.pending();f.throwCleanup(outputError,inputError);
    const work=f.resources.acquire(f.base,{representation:f.tiles,limitation:null},{signal:abort.signal,priority:5,overlap:true});const observed=work.catch(error=>error);await flush();await flush();
    expect(f.broker.pools.stats().decoded.reserved).toBe(24);expect(f.closed()).toBe(0);
    const reason=new Error("cancelled tiled acquisition");abort.abort(reason);expect(await observed).toBe(reason);expect(f.cache.stats().heldReferences).toBe(0);expect(f.events).toEqual(["atlas"]);expect(f.broker.pools.stats().decoded.reserved).toBe(24);
    f.gate.resolve();await flush();await flush();expect(f.events).toEqual(["atlas","cube"]);expect(f.closed()).toBe(6);
    const failure=f.loadErrors.find(error=>leaves(error).includes(outputError))!;expect(failure).toBeDefined();const errors=leaves(failure);expect(errors.indexOf(outputError)).toBeLessThan(errors.indexOf(inputError));
    expect(f.broker.pools.live()).toEqual([]);f.cleanup();
  });
});
