import type { ImageAsset } from "@foss-earth/images";
export interface PreparationPorts { ownerDirectory?: string; log?(text: string): void }
export interface PreparedPanorama { exitCode: number; out?: string; help?: string; fragment?: { asset: ImageAsset; imagePose: {headingDeg:number;pitchDeg:number;rollDeg:number} }; provenance?: Record<string, unknown> }
/** Local files only; default scratch belongs to the supplied owner directory. */
export function preparePanorama(argv: readonly string[], ports?: PreparationPorts): PreparedPanorama;
