/** Run only in a reserved check turn. Install real archives with the owner's offline cache. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const owner=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."), stamp=new Date().toISOString().replaceAll(":","-");
const folder=path.join(owner,"build/consumers",stamp), workspace=path.join(folder,"installed");mkdirSync(workspace,{recursive:true});
const manifest=process.argv.find(arg=>arg.startsWith("--artifacts="))?.slice(12)??path.join(owner,"build/artifacts/consumer-dependencies.json");
const records=JSON.parse(readFileSync(manifest,"utf8"));assert(Array.isArray(records),"dependency archives must be a JSON array");
const digest=file=>createHash("sha256").update(readFileSync(file)).digest("hex");
function command(name,args,cwd=owner){const result=spawnSync(name,args,{cwd,encoding:"utf8",env:{...process.env,npm_config_cache:path.join(owner,"build/npm-cache"),TMPDIR:folder}});writeFileSync(path.join(folder,`${name.includes("npm")?"npm":"node"}-${args[0].replaceAll("/","-")}.log`),(result.stdout??"")+(result.stderr??""));assert.equal(result.status,0,`${name} ${args[0]} failed; retained ${folder}`);return result.stdout;}
const archives={};
for(const record of records){assert.equal(Object.keys(record).sort().join(","),"archive,name,sha256,version");assert.match(record.name,/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/);assert.match(record.sha256,/^[0-9a-f]{64}$/);const file=realpathSync(path.resolve(path.dirname(manifest),record.archive));assert.equal(digest(file),record.sha256,`${record.name} archive digest`);assert(!archives[record.name],"duplicate artifact identity");archives[record.name]={...record,file};}
const packed=JSON.parse(command("npm",["pack","--ignore-scripts","--json","--pack-destination",folder]))[0];
const ownArchive=path.join(folder,packed.filename);archives["@foss-earth/image-viewer"]={name:"@foss-earth/image-viewer",version:"0.1.0",file:ownArchive,sha256:digest(ownArchive)};
writeFileSync(path.join(workspace,"package.json"),JSON.stringify({name:"foss-earth-image-viewer-public-consumer",private:true,type:"module",dependencies:Object.fromEntries(Object.values(archives).map(record=>[record.name,`file:${record.file}`]))},null,2));
command("npm",["install","--offline","--ignore-scripts","--no-audit","--no-fund","--cache",path.join(owner,"build/npm-cache")],workspace);
for(const record of Object.values(archives)){const installed=JSON.parse(readFileSync(path.join(workspace,"node_modules",record.name,"package.json")));assert.equal(installed.name,record.name);assert.equal(installed.version,record.version);}
assert.equal(archives.typescript?.version,"5.9.3");assert.equal(archives["@types/node"]?.version,"24.12.4");
writeFileSync(path.join(workspace,"guard.mjs"),`import {registerHooks} from 'node:module';import{realpathSync}from'node:fs';import{fileURLToPath}from'node:url';import path from'node:path';const root=realpathSync(${JSON.stringify(workspace)});registerHooks({resolve(specifier,context,next){const result=next(specifier,context);if(result.url.startsWith('file:')){const file=realpathSync(fileURLToPath(result.url)),rel=path.relative(root,file);if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw new Error('OUTSIDE_INSTALLED_WORKSPACE');}else if(!result.url.startsWith('node:'))throw new Error('UNEXPECTED_MODULE_SCHEME');return result;}});`);
writeFileSync(path.join(workspace,"smoke.mjs"),readFileSync(path.join(owner,"fixtures/installed-consumer.mjs"),"utf8").replace("__OUTSIDE_IMPORT__",pathToFileURL(path.join(owner,"package.json")).href));
writeFileSync(path.join(workspace,"consumer.ts"),readFileSync(path.join(owner,"fixtures/public-consumer.ts")));
writeFileSync(path.join(workspace,"tsconfig.json"),JSON.stringify({compilerOptions:{target:"ES2022",module:"NodeNext",moduleResolution:"NodeNext",lib:["ES2022","DOM","DOM.Iterable"],strict:true,skipLibCheck:false,noEmit:true,incremental:true,tsBuildInfoFile:".typecheck.tsbuildinfo"},files:["consumer.ts"]}));
command(process.execPath,["--import",path.join(workspace,"guard.mjs"),path.join(workspace,"smoke.mjs")],workspace);
command(process.execPath,[path.join(workspace,"node_modules/typescript/bin/tsc"),"-p",path.join(workspace,"tsconfig.json")],workspace);
writeFileSync(path.join(folder,"receipt.json"),JSON.stringify({status:"passed installed public smoke/declarations",host:{node:process.version,platform:process.platform,arch:process.arch},archives:Object.values(archives).map(({name,version,sha256})=>({name,version,sha256})),exports:Object.keys(JSON.parse(readFileSync(path.join(owner,"package.json"))).exports),limits:"Only this Node host; no GPU/browser device performance, remote admission, publication or consumer-app adoption claimed."},null,2)+"\n");
console.log(`Passed installed consumer; receipt ${path.relative(owner,folder)}/receipt.json`);
