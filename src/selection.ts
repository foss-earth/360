import type { ImageRepresentation } from "@foss-earth/images";
import type { ViewerRepresentation } from "./catalogue.js";
import { previewFaceTexels, immersionFaceTexels } from "@foss-earth/sphere-cubemap/core";
import type { TiledCubeRepresentationRecord } from "@foss-earth/sphere-tiled-cubemap";
import type { ViewerImageInput } from "./ports.js";
import type { ViewerResources } from "./viewer.js";
export interface RepresentationChoice<R extends ImageRepresentation> {
  representation: R;
  limitation: string | null;
  next: { representation: R; reason: string } | null;
}
/** Retained source choice algorithm, using owner hooks for density/cost. */
export function chooseRepresentation<R extends ImageRepresentation>(
  representations: readonly R[], role: R["role"] | "any", wantedFaceTexels: number,
  registry: readonly ViewerRepresentation<R>[], context: { maxTextureSide: number },
  admissible: (representation: R) => string | null,
): RepresentationChoice<R> | null {
  const plugin = (record: R): ViewerRepresentation<R> => {
    const result = registry.find(entry => entry.hooks.projection === record.projection);
    if (!result) throw new Error(`No representation hook for ${record.projection}.`);
    return result;
  };
  const density = (record: R): number => plugin(record).faceTexels(record);
  const estimateErrors = new Map<R, string>();
  const gpuBytes = (record: R): number => {
    try { return plugin(record).hooks.estimate(record, context).sourceGpu; }
    catch (error) { estimateErrors.set(record, error instanceof Error ? error.message : String(error)); return Number.POSITIVE_INFINITY; }
  };
  const candidates = representations.filter(entry => role === "any" || entry.role === role)
    .sort((a, b) => density(a) - density(b) || gpuBytes(a) - gpuBytes(b));
  const refusals: { representation: R; reason: string }[] = [];
  let best: R | null = null;
  for (const candidate of candidates) {
    // Sorting a single candidate need not call the comparator, so validate
    // each estimate here too. A refused sharper image preserves the fallback.
    gpuBytes(candidate);
    const refusal = estimateErrors.get(candidate) ?? admissible(candidate);
    if (refusal) {
      refusals.push({ representation: candidate, reason: refusal });
      if (density(candidate) >= wantedFaceTexels) break;
      continue;
    }
    best = candidate;
    if (density(candidate) >= wantedFaceTexels) return { representation: candidate, limitation: null, next: null };
  }
  if (!best) return null;
  const chosen = best;
  const larger = candidates.filter(entry => density(entry) > density(chosen));
  const next = refusals.find(refusal => density(refusal.representation) > density(chosen)) ?? null;
  const limitation = larger.length === 0
    ? `the largest available is ${Math.round(density(chosen))} texels per face, below the ${Math.round(wantedFaceTexels)} asked for`
    : `a larger representation does not fit: ${refusals.map(refusal => `${refusal.representation.id}: ${refusal.reason}`).join("; ")}`;
  return { representation: chosen, limitation, next };
}

export interface ViewerSelectionParameters {
  previewFaces:{min:number;max:number}; previewFovDeg:number; previewDensity:number;
  immersionWidth:number; immersionDensity:number|null;
  preference:"equi-angular-tiles"|"cube-tiles"|"whole";
}
export interface ViewerSelectionPorts {
  representations:readonly ViewerRepresentation[];
  parameters():ViewerSelectionParameters;
  maxTextureSide():number;
  viewportHeightDevicePx():number|null;
  current(input:ViewerImageInput):{preview:string|null;shown:string|null};
  /** Common broker/cache admission, including reclaimable idle GPU sources. */
  admissible(representation:ImageRepresentation,overlap:boolean):string|null;
  imageName(representation:ImageRepresentation):string;
}
/** Retained preview range, representation preference and sharpness/detail policy. */
export function createViewerSelection(ports:ViewerSelectionPorts):Pick<ViewerResources,"preview"|"immersion"|"faceTexels"|"warm"> {
  const density=(record:ImageRepresentation):number=>{
    const owner=ports.representations.find(entry=>entry.hooks.projection===record.projection);
    if(!owner)throw new Error(`No public density hook for ${record.projection}.`);
    return owner.faceTexels(record);
  };
  function preview(input:ViewerImageInput,diameter:number|null) {
    const p=ports.parameters(),previews=input.asset.representations.filter(record=>record.role==="preview"&&record.projection==="cube");
    const inRange=previews.filter(record=>density(record)>=p.previewFaces.min&&density(record)<=p.previewFaces.max);
    const wanted=diameter===null?p.previewFaces.min:previewFaceTexels(diameter,p.previewFovDeg*Math.PI/360,p.previewDensity);
    const choice=chooseRepresentation(inRange.length?inRange:previews,"preview",Math.min(Math.max(wanted,p.previewFaces.min),p.previewFaces.max),ports.representations,{maxTextureSide:ports.maxTextureSide()},record=>ports.current(input).preview===record.id?null:ports.admissible(record,false));
    if(!choice)return null;
    const range=inRange.length?null:`no preview is within ${p.previewFaces.min}–${p.previewFaces.max} px (scene.panorama.previewFaceRange)`;
    return {representation:choice.representation,limitation:[range,choice.limitation].filter(Boolean).join("; ")||null};
  }
  const tilesName=(warp:string)=>warp==="equi-angular"?"equi-angular cube tiles":"cube tiles";
  const immersion:ViewerResources["immersion"]=(input,view,failed)=>{
    const p=ports.parameters(),current=ports.current(input);let note:string|null=null;
    if(p.preference!=="whole") {
      const warp=p.preference==="cube-tiles"?"gnomonic":"equi-angular";
      const offered=input.asset.representations.filter((record):record is TiledCubeRepresentationRecord=>record.projection==="tiled-cube"&&!failed.has(record.id));
      const preferred=offered.find(record=>record.warp===warp)??offered[0];
      if(preferred) {
        note=preferred.warp===warp?null:`This panorama has no ${tilesName(warp)}, so it shows its ${tilesName(preferred.warp)} (360 image settings → Image).`;
        const refusal=current.shown===preferred.id?null:ports.admissible(preferred,true);
        if(!refusal)return {representation:preferred,limitation:note};
        note=refusal;
      }
    }
    const height=ports.viewportHeightDevicePx();
    const wanted=p.immersionDensity!==null&&height!==null?immersionFaceTexels(height,view.verticalFovDeg*Math.PI/180,p.immersionDensity):Number.POSITIVE_INFINITY;
    const candidates=input.asset.representations.filter(record=>record.projection!=="tiled-cube"&&!failed.has(record.id)&&(record.role==="immersion"||record.id===current.shown||record.id===current.preview));
    const choice=chooseRepresentation(candidates,"any",wanted,ports.representations,{maxTextureSide:ports.maxTextureSide()},record=>{
      if(record.id===current.preview)return null;
      if(density(record)*4>p.immersionWidth)return `${ports.imageName(record)} is more than the ${Math.round(p.immersionWidth)} px image detail allows.`;
      return record.id===current.shown?null:ports.admissible(record,true);
    });
    if(!choice)return null;
    const largest=Math.max(...candidates.map(record=>density(record)*4));
    const reason=choice.next?.reason??(density(choice.representation)*4<largest&&p.immersionDensity!==null?`The sharpness target is met: ${Math.round(wanted)} texels per cube face, ${p.immersionDensity} per rendered pixel (360 image settings → Image).`:null);
    return {representation:choice.representation,limitation:[note,reason].filter(Boolean).join(" ")||null};
  };
  return {faceTexels:density,preview,immersion,warm(input,view){
    const choice=immersion(input,view,new Set());
    return choice?.representation.projection==="tiled-cube"?choice:null;
  }};
}
