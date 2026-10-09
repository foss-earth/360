import { describe, expect, it } from "vitest";
import { createBuiltInRepresentations, createViewerSelection, chooseRepresentation, validateViewerAsset } from "../src/index.js";
import type { ImageRepresentation } from "@foss-earth/images";
import { image } from "./fixtures/viewer.js";

const cube=(id:string,size:number,role:"preview"|"immersion"="preview")=>({id,role,projection:"cube",mimeType:"image/png",encodedBytes:60,faceSize:size,faces:Object.fromEntries(["px","nx","py","ny","pz","nz"].map(face=>[face,`https://fixture.invalid/${id}/${face}.png`]))}) as ImageRepresentation;
const registry=createBuiltInRepresentations(()=>({tileMemoryBytes:1024*1024,responseBytes:1024,requests:1,waiting:1,uploadOutstandingBytes:1024*1024}));
describe("viewer selection policy",()=>{
  it("warms only the tiled candidate selected by the current preference and admission",()=>{
    const input=image(),tiles={...cube("tiles",8,"immersion"),projection:"tiled-cube",warp:"gnomonic",faceSize:8,tileSize:2,gutter:0,levelBytes:[6,24,96],url:"https://fixture.invalid/tiles/"};
    input.asset={...input.asset,representations:[cube("preview",64),tiles]};let preference:"whole"|"cube-tiles"="cube-tiles",refused=false;
    const selection=createViewerSelection({representations:registry as never,parameters:()=>({previewFaces:{min:64,max:256},previewFovDeg:90,previewDensity:1,immersionWidth:4096,immersionDensity:null,preference}),maxTextureSide:()=>4096,viewportHeightDevicePx:()=>900,current:()=>({preview:"preview",shown:null}),admissible:record=>refused&&record.projection==="tiled-cube"?"tile budget full":null,imageName:record=>record.id});
    const view={headingDeg:0,pitchDeg:0,verticalFovDeg:60};expect(selection.warm!(input,view)?.representation.id).toBe("tiles");
    refused=true;expect(selection.warm!(input,view)).toBeNull();refused=false;preference="whole";expect(selection.warm!(input,view)).toBeNull();
  });
  it("requires a complete validated cube preview instead of inventing a format",()=>{const asset=image().asset;expect(validateViewerAsset({...asset,representations:[]},{path:"$.asset"})).toEqual([{path:"$.asset.representations",message:"must offer at least one complete cube preview"}]);});
  it("preserves the lower fitting source and reports a refused sharper representation",()=>{
    const small=cube("small",64),large=cube("large",256);
    const result=chooseRepresentation([large,small],"preview",128,registry as never,{maxTextureSide:2048},record=>record.id==="large"?"GPU memory full":null);
    expect(result?.representation.id).toBe("small");expect(result?.next?.reason).toBe("GPU memory full");
  });
  it("loads the smallest allowed preview first and honors a measured orb's density",()=>{
    const input=image();input.asset={...input.asset,representations:[cube("64",64),cube("128",128),cube("256",256)]};
    const selection=createViewerSelection({representations:registry as never,parameters:()=>({previewFaces:{min:64,max:256},previewFovDeg:90,previewDensity:1,immersionWidth:4096,immersionDensity:null,preference:"whole"}),maxTextureSide:()=>4096,viewportHeightDevicePx:()=>900,current:()=>({preview:null,shown:null}),admissible:()=>null,imageName:r=>r.id});
    expect(selection.preview(input,null)?.representation.id).toBe("64");expect(selection.preview(input,100)?.representation.id).toBe("128");expect(selection.preview(input,Infinity)?.representation.id).toBe("256");
  });
  it("keeps the published preview available when a whole image exceeds the detail cap",()=>{
    const input=image();input.asset={...input.asset,representations:[cube("preview",64),cube("large",1024,"immersion")]};
    const selection=createViewerSelection({representations:registry as never,parameters:()=>({previewFaces:{min:64,max:256},previewFovDeg:90,previewDensity:1,immersionWidth:512,immersionDensity:null,preference:"whole"}),maxTextureSide:()=>4096,viewportHeightDevicePx:()=>900,current:()=>({preview:"preview",shown:"preview"}),admissible:()=>null,imageName:r=>r.id});
    const result=selection.immersion(input,{headingDeg:0,pitchDeg:0,verticalFovDeg:60},new Set());expect(result?.representation.id).toBe("preview");expect(result?.limitation).toContain("512 px image detail");
  });
});
