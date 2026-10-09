import type { ImageDiagnostic, RepresentationHooks } from "@foss-earth/images";
import type { ValidatedScene } from "@foss-earth/scenes";
export interface SceneFileReport { problems: ImageDiagnostic[]; files: number; bytes: number; largestFile: {url:string;bytes:number}|null }
export interface SceneCheckReport { manifest:string;baseUrl:string;ok:boolean;errors:readonly ImageDiagnostic[];warnings:readonly ImageDiagnostic[];problems:readonly ImageDiagnostic[];summary:Record<string,unknown>|null }
export function localSceneReader(folder:string, baseUrl:string|URL): {outside:Set<string>;read(url:string):Uint8Array|null};
export function checkSceneFiles(scene:ValidatedScene, read:(url:string)=>Uint8Array|null, representations:readonly RepresentationHooks[]):SceneFileReport;
export function checkSceneManifest(manifestPath:string, options?:{baseUrl?:string|URL}):SceneCheckReport;
