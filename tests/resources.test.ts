import { describe, expect, it, vi } from "vitest";
import { createImageSessionBroker, createImageSourceCache, mediaGroup } from "@foss-earth/images";
import { createImageFileService, type ImageFileService } from "@foss-earth/images/browser";
import { tileAtlasLayout, type TiledCubeRepresentationRecord } from "@foss-earth/tiled-cubemap";
import { createViewerResources, type ComposedImageSource, type ViewerResourceCompositionPorts } from "../src/resources.js";
import type { CubeRepresentationRecord } from "@foss-earth/cubemap";
import { image } from "./fixtures/viewer.js";

describe("public leaf resource composition",()=>{
  it("shares a factory/texture across placed images and keeps overlap through the host swap",async()=>{
    const broker=createImageSessionBroker({pools:{encoded:1e6,decoded:1e6,sourceGpu:1e6,overlap:1e6,uploadOutstanding:1e6},requests:2,decodes:1});
    const cache=createImageSourceCache<ComposedImageSource>({broker,keptGpuBytes:0,gpuBytes:r=>r.gpuBytes});
    const record:CubeRepresentationRecord={id:"preview",role:"preview",projection:"cube",mimeType:"image/png",encodedBytes:6,faceSize:1,faces:{px:"https://fixture.invalid/px",nx:"https://fixture.invalid/nx",py:"https://fixture.invalid/py",ny:"https://fixture.invalid/ny",pz:"https://fixture.invalid/pz",nz:"https://fixture.invalid/nz"}};
    const release=vi.fn(),close=vi.fn(),dispose=vi.fn(),upload=vi.fn(async()=>({kind:"cube",width:1,height:1,levels:1,gpuBytes:24,texture:{} as never,complete:true,dispose}));
    const ports:ViewerResourceCompositionPorts={broker,cache,atlasDevice:{} as never,uploader:{upload,pump:()=>0,busy:()=>false,setLimits:()=>{},stats:()=>({queuedJobs:0,outstandingBytes:0,lastFrameBytes:0,uploadedBytes:0,publishedCompletionFailures:0,lastPublishedCompletionFailure:null}),cancelAll:()=>{}},files:{obtain:vi.fn(async()=>({bytes:new Uint8Array([0]),contentType:"image/png",fromCache:false,release})),decode:vi.fn(async()=>({image:{width:1,height:1,close} as never,close}))},previewSheetsEnabled:()=>false,maxTextureSide:()=>4096,whenReady:async()=>{},estimate:()=>({encoded:6,decoded:24,sourceGpu:24,uploadOutstanding:24}),choice:{preview:()=>({representation:record,limitation:null}),immersion:()=>null,faceTexels:()=>1},tiles:{memoryBytes:()=>1024,limits:()=>({requests:1,waiting:1,decodes:1,uploadsPerFrame:1,retries:0,retryDelayMs:1,fadeMs:0}),selection:()=>({texelsPerPixel:1,marginDeg:0,levelCap:0}),outlines:()=>false},devicePixelsPerCss:()=>1,requestRender:()=>{}};
    const resources=createViewerResources(ports),input=image();input.asset={...input.asset,representations:[record]};
    const choice=resources.preview(input,null)!;
    const [first,second]=await Promise.all([resources.acquire(input,choice,{signal:new AbortController().signal,priority:3,overlap:true}),resources.acquire({...input,id:"placed-b"},choice,{signal:new AbortController().signal,priority:1,overlap:true})]);
    expect(upload).toHaveBeenCalledTimes(1);expect(first.source.texture).toBe(second.source.texture);expect(broker.pools.stats().overlap.reserved).toBe(24);
    first.release();expect(dispose).not.toHaveBeenCalled();second.settleReplacement();expect(broker.pools.stats().overlap.reserved).toBe(0);
    second.release();expect(dispose).toHaveBeenCalledTimes(1);expect(broker.pools.stats().sourceGpu.reserved).toBe(0);expect(close).toHaveBeenCalledTimes(6);
    cache.dispose();broker.dispose();
  });
  it("selects distinct common saved-media services for reused URLs and recursive previews",async()=>{
    const broker=createImageSessionBroker({pools:{encoded:1000,decoded:1000,sourceGpu:1e6,overlap:1e6,uploadOutstanding:1000},requests:2,decodes:1});
    const cache=createImageSourceCache<ComposedImageSource>({broker,keptGpuBytes:0,gpuBytes:source=>source.gpuBytes});
    const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,0,0,0,0]);
    const preview:CubeRepresentationRecord={id:"preview",role:"preview",projection:"cube",mimeType:"image/png",encodedBytes:198,faceSize:1,faces:{px:"https://fixture.invalid/shared/px",nx:"https://fixture.invalid/shared/nx",py:"https://fixture.invalid/shared/py",ny:"https://fixture.invalid/shared/ny",pz:"https://fixture.invalid/shared/pz",nz:"https://fixture.invalid/shared/nz"}};
    const alternate:CubeRepresentationRecord={...preview,id:"alternate"};
    const tiles:TiledCubeRepresentationRecord={id:"tiles",role:"immersion",projection:"tiled-cube",mimeType:"image/png",encodedBytes:126,warp:"gnomonic",faceSize:8,tileSize:2,gutter:0,levelBytes:[6,24,96],url:"https://fixture.invalid/tiles/"};
    const filesByGroup=new Map<string,ImageFileService>(),selected:string[]=[],reads:{group:string;url:string}[]=[];
    const network=vi.fn(async()=>{throw new Error("Every grouped fixture file is already saved.");});
    const fallbackObtain=vi.fn(async()=>{throw new Error("Grouped loads must select their own common service.");});
    const fallbackDecode=vi.fn(async()=>{throw new Error("Grouped loads must decode through their selected service.");});
    const close=vi.fn();
    const ports:ViewerResourceCompositionPorts={broker,cache,atlasDevice:{} as never,
      files:{obtain:fallbackObtain,decode:fallbackDecode},
      filesFor(input,representation){
        const group=mediaGroup(input.asset,representation);selected.push(group.id);
        let service=filesByGroup.get(group.id);
        if(!service){
          service=createImageFileService({broker,priority:()=>0,limits:()=>({responseBytes:1000,timeoutMs:1000}),fetch:network,
            decode:async()=>({width:1,height:1,close} as unknown as ImageBitmap),
            cache:{files:{get:async()=>null,async getBounded(url,admission){
              reads.push({group:group.id,url});
              if(!admission.admit(png.byteLength))return null;
              return{bytes:png.slice(),contentType:"image/png"};
            },put(){},forget(){}},settled:async()=>{}}});
          filesByGroup.set(group.id,service);
        }
        return service;
      },
      uploader:{upload:async()=>({kind:"cube",width:1,height:1,levels:1,gpuBytes:24,texture:{} as never,complete:true,dispose(){}}),pump:()=>0,busy:()=>false,setLimits(){},stats:()=>({queuedJobs:0,outstandingBytes:0,lastFrameBytes:0,uploadedBytes:0,publishedCompletionFailures:0,lastPublishedCompletionFailure:null}),cancelAll(){}},
      previewSheetsEnabled:()=>false,maxTextureSide:()=>4096,whenReady:async()=>{},
      estimate:record=>({encoded:0,decoded:0,sourceGpu:record.projection==="tiled-cube"?tileAtlasLayout(record as TiledCubeRepresentationRecord,4096,4096)!.gpuBytes:24,uploadOutstanding:0}),
      choice:{preview:()=>({representation:preview,limitation:null}),immersion:()=>null,warm:()=>({representation:tiles,limitation:null}),faceTexels:()=>1},
      tiles:{memoryBytes:()=>4096,limits:()=>({requests:1,waiting:1,decodes:1,uploadsPerFrame:1,retries:0,retryDelayMs:1,fadeMs:0}),selection:()=>({texelsPerPixel:1,marginDeg:0,levelCap:0}),outlines:()=>false},
      createAtlas:({layout})=>({layout,atlas:{} as never,table:{} as never,beginUpdate:()=>true,endUpdate(){},uploadTile:()=>true,setTable:()=>true,dispose(){}}),devicePixelsPerCss:()=>1,requestRender(){}};
    const resources=createViewerResources(ports),base=image();
    const placed=(revision:string)=>({...base,asset:{...base.asset,id:"shared-asset",revision,representations:[preview,alternate,tiles]}});
    const handles=[];
    try{
      for(const [input,representation] of [[placed("v1"),preview],[placed("v2"),preview],[placed("v1"),alternate],[placed("v3"),tiles]] as const){
        handles.push(await resources.acquire(input,{representation,limitation:null},{signal:new AbortController().signal,priority:0,overlap:false}));
      }
      const repeated=await resources.acquire({...placed("v1"),id:"another-placement"},{representation:preview,limitation:null},{signal:new AbortController().signal,priority:0,overlap:false});
      handles.push(repeated);
      expect(selected).toEqual(["shared-asset@v1/preview","shared-asset@v2/preview","shared-asset@v1/alternate","shared-asset@v3/tiles","shared-asset@v3/preview"]);
      expect(filesByGroup.size).toBe(5);expect(new Set(filesByGroup.values()).size).toBe(5);
      for(const group of ["shared-asset@v1/preview","shared-asset@v2/preview","shared-asset@v1/alternate","shared-asset@v3/preview"]){
        expect(reads.filter(read=>read.group===group).map(read=>read.url)).toEqual(Object.values(preview.faces));
      }
      expect(reads).toHaveLength(24);expect(close).toHaveBeenCalledTimes(24);
      expect(handles[0].source.texture).not.toBe(handles[1].source.texture);expect(handles[0].source.texture).not.toBe(handles[2].source.texture);
      expect(repeated.source.texture).toBe(handles[0].source.texture);
      expect(resources.warm!(placed("v3"),{headingDeg:0,pitchDeg:0,verticalFovDeg:60})?.key).toBe(handles[3].key);
      expect(network).not.toHaveBeenCalled();expect(fallbackObtain).not.toHaveBeenCalled();expect(fallbackDecode).not.toHaveBeenCalled();
      expect(broker.pools.stats().sourceGpu.reserved).toBe(96+tileAtlasLayout(tiles,4096,4096)!.gpuBytes);
    }finally{for(const handle of handles)handle.release();cache.dispose();broker.dispose();}
    for(let n=0;n<20;n++)await Promise.resolve();expect(broker.pools.live()).toEqual([]);
  });
});
