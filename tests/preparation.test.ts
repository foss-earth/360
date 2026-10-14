import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { prepareSphere } from "../node/preparation.mjs";
import { cubeRepresentation } from "@foss-earth/sphere-cubemap";
import { createTiledCubeRepresentation } from "@foss-earth/sphere-tiled-cubemap";
import { equirectRepresentation } from "@foss-earth/sphere-equirectangular";
import { checkImage } from "@foss-earth/images";

describe("public preparation orchestration",()=>{
  it("keeps explicit pose provenance and writes valid cube/whole/tiled files through owner APIs",()=>{
    const parent=path.resolve("build/checks/preparation-fixtures");mkdirSync(parent,{recursive:true});const owner=mkdtempSync(path.join(parent,"source-"));
    const pose=path.join(owner,"pose.json");writeFileSync(pose,JSON.stringify({headingDeg:37,pitchDeg:-4,rollDeg:12,provenance:"synthetic fixture author"}));
    const result=prepareSphere(["--input","synthetic:cardinal:64","--pose",pose,"--attribution","Fixture author","--preview-face-sizes","8,16","--immersion-widths","32,64","--tiles","eac,cube","--tile-size","8","--tile-face-size","16","--encoding","png"],{ownerDirectory:owner,log:()=>{}});
    expect(result.exitCode).toBe(0);expect(result.out).toContain(path.join(owner,"build/prepared-scenes"));expect(result.fragment?.imagePose).toEqual({headingDeg:37,pitchDeg:-4,rollDeg:12});
    const hooks=[cubeRepresentation,equirectRepresentation,createTiledCubeRepresentation(()=>({tileMemoryBytes:1024*1024,responseBytes:1024*1024,requests:1,waiting:1,uploadOutstandingBytes:1024*1024}))];
    for(const record of result.fragment!.asset.representations){const owner=hooks.find(h=>h.projection===record.projection)!;const validated=owner.validate(record as never,{path:"$.asset",baseUrl:"https://fixture.invalid/asset.json"});expect(validated.ok).toBe(true);if(!validated.ok)continue;let total=0;for(const file of owner.files(validated.representation as never)){const bytes=new Uint8Array(readFileSync(path.join(result.out!,new URL(file.url).pathname.slice(1))));expect(checkImage(bytes,file,null)).toBeNull();total+=bytes.length;}expect(total).toBe(record.encodedBytes);}
    expect(result.provenance?.toolVersion).toBe("2");expect(result.provenance).not.toHaveProperty("libSha256");expect(result.provenance).toHaveProperty("components");
  });
  it("refuses an absent pose instead of inventing aligned north",()=>{
    expect(()=>prepareSphere(["--input","synthetic:cardinal:64","--attribution","Fixture author","--preview-face-sizes","8"],{log:()=>{}})).toThrow(/no pose/);
  });
});
