import type { ImageAsset, ImageDiagnostic, ImageRepresentation, RepresentationHooks } from "@foss-earth/images";
import { cubeRepresentation, type CubeRepresentationRecord } from "@foss-earth/sphere-cubemap";
import { equirectRepresentation, type EquirectRepresentationRecord } from "@foss-earth/sphere-equirectangular";
import { createTiledCubeRepresentation, type TiledCubeRepresentationRecord, type TiledResourceParameters } from "@foss-earth/sphere-tiled-cubemap";

export type BuiltInRepresentation = CubeRepresentationRecord | EquirectRepresentationRecord | TiledCubeRepresentationRecord;
export interface ViewerRepresentation<R extends ImageRepresentation = ImageRepresentation> {
  hooks: RepresentationHooks<R>;
  /** Common density scale; supplied by the representation adapter. */
  faceTexels(record: R): number;
}
/** Built-in composition ONLY here; leaf cores and scenes receive these hooks. */
export function createBuiltInRepresentations(tiledParameters: () => TiledResourceParameters): readonly ViewerRepresentation<BuiltInRepresentation>[] {
  // Each hook is called only for its matching projection; a catalogue-wide
  // generic type preserves the public union without changing leaf validators.
  return [
    { hooks: cubeRepresentation, faceTexels: (record: CubeRepresentationRecord) => record.faceSize },
    { hooks: equirectRepresentation, faceTexels: (record: EquirectRepresentationRecord) => record.width / 4 },
    { hooks: createTiledCubeRepresentation(tiledParameters), faceTexels: (record: TiledCubeRepresentationRecord) => record.faceSize },
  ] as readonly ViewerRepresentation<BuiltInRepresentation>[];
}
/** Existing v1 preview policy delegated by scene validation to the viewer. */
export function validateViewerAsset(asset: ImageAsset, context: { path: string }): readonly ImageDiagnostic[] {
  return asset.representations.some(record => record.role === "preview" && record.projection === "cube")
    ? [] : [{ path: `${context.path}.representations`, message: "must offer at least one complete cube preview" }];
}
