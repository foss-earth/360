/** Optional Babylon composition: all formats use the supplied common session and uploader. */
import type { BaseTexture } from "@babylonjs/core";
import { imageSourceKey, mulMat3, type ImageEstimate, type ImageOperationScope, type ImageRepresentation, type ImageSessionBroker, type ImageSourceCache, type ImageSourceHold, type ImageSourceRequest, type Mat3 } from "@foss-earth/images";
import type { ImageFileService, WholeImagePorts } from "@foss-earth/images/browser";
import { CUBE_FACE_NAMES } from "@foss-earth/cubemap/core";
import { acquireCubeFaces, loadCube } from "@foss-earth/cubemap/browser";
import { createCubeUploadAdapter } from "@foss-earth/cubemap/babylon";
import type { CubeRepresentationRecord } from "@foss-earth/cubemap";
import { loadEquirect } from "@foss-earth/equirectangular/browser";
import { createEquirectUploadAdapter } from "@foss-earth/equirectangular/babylon";
import type { EquirectRepresentationRecord } from "@foss-earth/equirectangular";
import { createTiledPanorama, type TiledPanorama } from "@foss-earth/tiled-cubemap/browser";
import { createPanoramaTileAtlas, type PanoramaTileAtlas } from "@foss-earth/tiled-cubemap/babylon";
import { tileAtlasLayout, type TileAtlasLayout, type TileSelectionParameters, type TileSchedulerLimits, type TiledCubeRepresentationRecord } from "@foss-earth/tiled-cubemap";
import type { PreviewSheetSources, } from "@foss-earth/preview-sheets/browser";
import type { ResolvedSheetPlace } from "@foss-earth/preview-sheets/core";
import type { ImageTextureUploader, UploadedImageTexture, ImageRegionDevicePorts } from "@foss-earth/renderer/babylon";
import type { ViewerResources, ViewerSource, ViewerSourceChoice } from "./viewer.js";
import type { ViewerImageInput } from "./ports.js";
import type { PanoramaCameraFrame, ImmersionSource, TiledSourceTextures } from "./renderer.js";

export interface ComposedImageSource {
  readonly representation:ImageRepresentation;
  /** Whole sources are complete. A cached tiled entry owns only its atlas/table;
   * its complete source is composed with a per-acquisition cube hold. */
  readonly source:Omit<ImmersionSource,"content">|null;
  readonly tiles?:TiledSourceTextures;
  readonly gpuBytes:number;
  isCurrent():boolean;
  dispose():void;
  settleReplacement():void;
  onFrame?(camera:PanoramaCameraFrame,content:Mat3,now:number):boolean;
  viewReady?():boolean;
  detail?():ReturnType<TiledPanorama["stats"]>;
}
export interface ViewerResourceCompositionPorts {
  broker:ImageSessionBroker;
  /** Construct once with images.createImageSourceCache; this composition never creates another cache. */
  cache:ImageSourceCache<ComposedImageSource>;
  files:ImageFileService;
  /** Optional common service bound to this asset revision/representation's saved
   * media group. It must share the supplied broker. Recursive preview fallback
   * selects its own group; omitting this port preserves the existing files path. */
  filesFor?(input:ViewerImageInput,representation:ImageRepresentation):ImageFileService;
  /** Actual published preview identity, never a private/prepared source. Stale
   * asset/revision or non-preview IDs are ignored. Without a matching reading,
   * use the first declared complete cube preview as the original loader did. */
  previewForTiles?(input:ViewerImageInput,representation:TiledCubeRepresentationRecord):{
    asset:{id:string;revision:string};representation:string;
  }|null;
  uploader:ImageTextureUploader;
  /** Host renderer device adapter shares the same transfer tracker and frame. */
  atlasDevice:ImageRegionDevicePorts;
  sheets?:PreviewSheetSources;
  previewSheetsEnabled():boolean;
  maxTextureSide():number;
  whenReady(texture:BaseTexture,signal:AbortSignal):Promise<void>;
  /** Owner hooks provide source/peak costs and the host's current user budgets. */
  estimate(representation:ImageRepresentation):ImageEstimate;
  choice:Pick<ViewerResources,"preview"|"immersion"|"faceTexels"|"warm">;
  tiles:{memoryBytes():number;limits():TileSchedulerLimits;selection(representation:TiledCubeRepresentationRecord):TileSelectionParameters;outlines():boolean};
  devicePixelsPerCss():number;
  requestRender():void;
  /** Optional test/device binding; production defaults to the public tiled owner adapter. */
  createAtlas?(options:Parameters<typeof createPanoramaTileAtlas>[0]):PanoramaTileAtlas;
}
/** No renderer, broker, uploader, timer or frame subscription is constructed here. */
export function createViewerResources(ports:ViewerResourceCompositionPorts):ViewerResources {
  const attempt=(actions:readonly (()=>void)[],primary:readonly unknown[]=[],label="Image source cleanup failed."):void=>{
    const errors=[...primary];
    for(const action of actions){try{action();}catch(error){errors.push(error);}}
    if(errors.length)throw errors.length===1?errors[0]:new AggregateError(errors,label);
  };
  const keyFor=(input:ViewerImageInput,record:ImageRepresentation):string=>{
    const layout=record.projection==="tiled-cube"?tileAtlasLayout(record as TiledCubeRepresentationRecord,ports.tiles.memoryBytes(),ports.maxTextureSide()):null;
    const urls=record.projection==="cube"?CUBE_FACE_NAMES.map(face=>(record as CubeRepresentationRecord).faces[face]).join(" "):(record as EquirectRepresentationRecord|TiledCubeRepresentationRecord).url;
    return imageSourceKey(input.asset,record)+`#${ports.broker.generation()} ${urls}`+(layout?`/atlas:${layout.slots}:${layout.width}:${layout.height}`:"");
  };
  const keyed=(input:ViewerImageInput,choice:ViewerSourceChoice|null):ViewerSourceChoice|null=>choice?{...choice,key:keyFor(input,choice.representation)}:null;
  async function acquire(input:ViewerImageInput,choice:ViewerSourceChoice,request:{signal:AbortSignal;priority:number;overlap:boolean}):Promise<ViewerSource> {
    request.signal.throwIfAborted();
    const record=choice.representation,estimate=ports.estimate(record);
    const layout=record.projection==="tiled-cube"?tileAtlasLayout(record as TiledCubeRepresentationRecord,ports.tiles.memoryBytes(),ports.maxTextureSide()):null;
    if(record.projection==="tiled-cube"&&!layout)throw new Error("No tiled atlas fits the current device and tile memory.");
    const key=keyFor(input,record);
    let preview:CubeRepresentationRecord|undefined;
    if(record.projection==="tiled-cube"){
      const published=ports.previewForTiles?.(input,record as TiledCubeRepresentationRecord);
      if(published?.asset.id===input.asset.id&&published.asset.revision===input.asset.revision){
        preview=input.asset.representations.find((candidate):candidate is CubeRepresentationRecord=>candidate.id===published.representation&&candidate.role==="preview"&&candidate.projection==="cube");
      }
      preview??=input.asset.representations.find((candidate):candidate is CubeRepresentationRecord=>candidate.role==="preview"&&candidate.projection==="cube");
      if(!preview)throw new Error("A tiled image needs a complete cube preview.");
    }
    const pending=ports.cache.acquire(key,{...request,estimatedGpuBytes:estimate.sourceGpu,load:(scope,loadRequest)=>load(input,record,scope,loadRequest,layout)});
    let held:ImageSourceHold<ComposedImageSource>,fallback:ViewerSource|null=null;
    if(preview){
      // Atlas and fallback are independent common-cache sources. Each caller
      // holds both, so a kept atlas neither pins nor reuses a private preview.
      const [atlasResult,previewResult]=await Promise.allSettled([pending,acquire(input,{representation:preview,limitation:null},{...request,overlap:false})]);
      if(atlasResult.status==="rejected"||previewResult.status==="rejected"){
        const errors:unknown[]=[],cleanup:(()=>void)[]=[];
        if(atlasResult.status==="rejected")errors.push(atlasResult.reason);else cleanup.push(()=>atlasResult.value.release());
        if(previewResult.status==="rejected"){if(!errors.includes(previewResult.reason))errors.push(previewResult.reason);}else cleanup.push(()=>previewResult.value.release());
        attempt(cleanup,errors,"Tiled source acquisition and cleanup failed.");
        throw new Error("The tiled source acquisition did not settle.");
      }
      held=atlasResult.value;fallback=previewResult.value;
    }else held=await pending;
    const release=():void=>attempt([()=>held.release(),()=>fallback?.release()]);
    try{
      request.signal.throwIfAborted();
      if(!held.resource.isCurrent()||fallback?.isCurrent?.()===false)throw new Error("The composed image source generation ended.");
    }catch(error){attempt([release],[error],"Image acquisition and cleanup failed.");throw error;}
    const source:Omit<ImmersionSource,"content">|null=fallback&&held.resource.tiles
      ?{texture:fallback.source.texture,kind:"tiles",tiles:held.resource.tiles}:held.resource.source;
    if(!source){attempt([release],[new Error("A cached tiled atlas needs its complete per-acquisition cube preview.")]);throw new Error("No complete image source.");}
    let released=false,settled=false;
    return {key,representation:record,isCurrent:()=>!released&&held.resource.isCurrent()&&fallback?.isCurrent?.()!==false,source,release(){if(released)return;released=true;release();},settleReplacement(){if(settled)return;settled=true;attempt([()=>held.settleReplacement(),()=>fallback?.settleReplacement()],[],"Image replacement settlement failed.");},
      ...(held.resource.detail?{detail:()=>{
        const value=held.resource.detail!(), highest=(record as TiledCubeRepresentationRecord).levelBytes.length-1;
        const state=value.complete?"every tile the view needs is on screen":`${value.shownInView} of ${value.inView} tiles in view on screen${value.loading?`, ${value.loading} loading`:""}`;
        const bytes=value.receivedBytes>=1024*1024?`${(value.receivedBytes/1024/1024).toFixed(1)} MiB`:`${Math.round(value.receivedBytes/1024)} KiB`;
        return {representation:record.id,progress:[`${state.charAt(0).toUpperCase()}${state.slice(1)}, at level ${value.levelWanted} of ${highest}; ${value.resident} of ${value.slots} tiles held, ${bytes} downloaded${value.reusedTiles?`, ${value.reusedTiles} ${value.reusedTiles===1?"tile":"tiles"} from saved images`:""}.`]};
      }}:{}),
      ...(held.resource.viewReady?{viewReady:()=>!released&&held.resource.viewReady!()}:{}),
      ...(held.resource.onFrame?{onFrame:(camera:PanoramaCameraFrame,now:number,content:Mat3)=>!released&&held.resource.onFrame!(camera,content,now)}:{}),
    };
  }
  async function load(input:ViewerImageInput,record:ImageRepresentation,scope:ImageOperationScope,request:ImageSourceRequest,layout:TileAtlasLayout|null):Promise<ComposedImageSource> {
    const files=ports.filesFor?.(input,record)??ports.files;
    const whole:WholeImagePorts<UploadedImageTexture>={broker:ports.broker,scope,overlap:request.overlap,maxTextureSide:ports.maxTextureSide(),obtain:(file,bytes)=>files.obtain(file,bytes,scope,undefined,request.priority),decode:(body,file)=>files.decode(body,file,scope,request.priority),whenReady:(uploaded,signal)=>ports.whenReady(uploaded.texture,signal)};
    if(record.projection==="cube") {
      const cube=record as CubeRepresentationRecord & {sheet?:ResolvedSheetPlace};
      const loaded=await loadCube(cube,{...whole,label:`${input.asset.id}/${record.id}`,uploadCube:createCubeUploadAdapter(ports.uploader,ports.broker,scope),
        ...(ports.sheets?{acquireFaces:()=>ports.sheets!.acquireCubeFaces({sheet:cube.sheet,faceSize:cube.faceSize,label:record.id,enabled:ports.previewSheetsEnabled(),scope,fallback:()=>acquireCubeFaces(cube,whole)})}:{}),});
      return {representation:record,source:{texture:loaded.texture.texture,kind:"cube"},gpuBytes:loaded.estimate.sourceGpu,isCurrent:()=>scope.isCurrent(),dispose:loaded.dispose,settleReplacement:loaded.settleReplacement};
    }
    if(record.projection==="equirectangular") {
      const loaded=await loadEquirect(record as EquirectRepresentationRecord,{...whole,label:`${input.asset.id}/${record.id}`,uploadEquirect:createEquirectUploadAdapter(ports.uploader,ports.broker,scope)});
      return {representation:record,source:{texture:loaded.texture.texture,kind:"equirectangular"},gpuBytes:loaded.estimate.sourceGpu,isCurrent:()=>scope.isCurrent(),dispose:loaded.dispose,settleReplacement:loaded.settleReplacement};
    }
    if(record.projection!=="tiled-cube"||!layout)throw new Error(`No public resource adapter for ${record.projection}.`);
    let atlas:PanoramaTileAtlas|null=null,tiled:TiledPanorama|null=null,disposed=false;
    const dispose=():void=>{if(disposed)return;disposed=true;scope.signal.removeEventListener("abort",dispose);tiled?.dispose();};
    scope.signal.addEventListener("abort",dispose,{once:true});
    try {
      scope.signal.throwIfAborted();
      tiled=createTiledPanorama({representation:record as TiledCubeRepresentationRecord,layout,broker:ports.broker,scope,overlap:request.overlap,limits:ports.tiles.limits(),wake:ports.requestRender,
        obtain:(file,bytes,operation,onChunk)=>files.obtain(file,bytes,operation,onChunk,request.priority),decode:(body,file,operation)=>files.decode(body,file,operation,request.priority),
        createAtlas(atlasLayout,cells){atlas=(ports.createAtlas??createPanoramaTileAtlas)({device:ports.atlasDevice,layout:atlasLayout,cells,label:`${input.asset.id}/${record.id}`,
          reserveUpload(bytes,label){const grant=ports.broker.pools.reserve("uploadOutstanding",bytes,label);return grant.ok?grant.reservation:null;}});return atlas;},});
      const texture=atlas! as PanoramaTileAtlas;
      await ports.whenReady(texture.atlas,scope.signal);await ports.whenReady(texture.table,scope.signal);scope.signal.throwIfAborted();
      const tiles:TiledSourceTextures={atlas:texture.atlas,table:texture.table,layout:[(record as TiledCubeRepresentationRecord).faceSize/(record as TiledCubeRepresentationRecord).tileSize,(record as TiledCubeRepresentationRecord).tileSize,(record as TiledCubeRepresentationRecord).gutter,layout.stored],atlasSize:[layout.width,layout.height],warp:(record as TiledCubeRepresentationRecord).warp,outlines:ports.tiles.outlines()};
      return {representation:record,source:null,tiles,gpuBytes:layout.gpuBytes,isCurrent:()=>scope.isCurrent()&&!disposed,dispose,settleReplacement:()=>tiled!.settleReplacement(),viewReady:()=>tiled!.stats().complete,detail:()=>tiled!.stats(),
        onFrame(camera,content,now){if(disposed)return false;tiles.outlines=ports.tiles.outlines();tiled!.setLimits(ports.tiles.limits());const fov=Math.tan(camera.view.verticalFovRad/2);return tiled!.tick(now,{forward:mulMat3(content,camera.view.forward),right:mulMat3(content,camera.view.right),up:mulMat3(content,camera.view.up),tanHalfWidth:fov*camera.view.aspect,tanHalfHeight:fov,heightPx:camera.viewportHeightCssPx*ports.devicePixelsPerCss()},ports.tiles.selection(record as TiledCubeRepresentationRecord));}};
    } catch(error){attempt([dispose],[error],"Tiled atlas preparation and cleanup failed.");throw error;}
  }
  return {warm:(input,view)=>keyed(input,ports.choice.warm?.(input,view)??null),preview:(input,diameter)=>keyed(input,ports.choice.preview(input,diameter)),immersion:(input,view,failed)=>keyed(input,ports.choice.immersion(input,view,failed)),faceTexels:record=>ports.choice.faceTexels(record),acquire};
}
