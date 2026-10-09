/** Compile only against the installed exports map; no sibling source aliases. */
import { createBuiltInRepresentations, validateViewerAsset, createViewerSelection, PANORAMA_GAMEPAD_ACTIONS, createPanoramaProfileContribution, type PanoramaProfileContribution, type ImageViewer, type PublishedImageViewer, type ViewerResourceReadings, type ViewerWorldMath } from "@foss-earth/360";
import { createImageViewer, type ImageViewerOptions } from "@foss-earth/360/viewer";
import type { ViewerResources } from "@foss-earth/360/viewer";
import { createViewerResources, type ComposedImageSource, type ViewerResourceCompositionPorts } from "@foss-earth/360/resources";
import { createViewerTabs, type ViewerPanelPorts } from "@foss-earth/360/panels";
import { VIEWER_PARAMETERS, VIEWER_SECTION_TITLES, VIEWER_EXPERIMENT_IDS, VIEWER_EXPERIMENT_PARAMETERS } from "@foss-earth/360/settings";
import { preparePanorama } from "@foss-earth/360/preparation";
import { levelUp, orbitAngles, orbitLook, pointGeodetic, glideSettling } from "@foss-earth/engine/core";
import { createStandardGlobeProfile, type GlobeGamepadAdapterOptions, type GlobeProfileContributions } from "@foss-earth/engine/gamepad";
import { DEFAULT_BINDING_TRANSFORM, type BindingSpec } from "@felipegalind0/gamepad-tools/core";
import { mediaGroup } from "@foss-earth/images";
import type { ImageFileService } from "@foss-earth/images/browser";
export const groupedFiles = (services: ReadonlyMap<string, ImageFileService>): NonNullable<ViewerResourceCompositionPorts["filesFor"]> =>
  (input, representation) => {
    const service = services.get(mediaGroup(input.asset, representation).id);
    if (!service) throw new Error("The host has not supplied this exact saved-media group.");
    return service;
  };
export const panoramaContribution: PanoramaProfileContribution = createPanoramaProfileContribution(DEFAULT_BINDING_TRANSFORM);
export const globeContribution: GlobeProfileContributions = panoramaContribution;
export const controllerOptions: GlobeGamepadAdapterOptions = { featureActions: PANORAMA_GAMEPAD_ACTIONS };
export const controllerProfile = createStandardGlobeProfile(0, undefined, globeContribution);
export const panoramaBindings: readonly BindingSpec[] = panoramaContribution.bindings(3, 0.21);
export const tileSelection: ViewerResourceCompositionPorts["tiles"]["selection"] = representation => ({
  texelsPerPixel: 1, marginDeg: 0,
  levelCap: Math.max(0, Math.min(representation.levelBytes.length - 1, Math.floor(Math.log2(16 / (4 * representation.tileSize))))),
});
export const world:ViewerWorldMath={levelUp,orbitAngles,orbitLook,pointGeodetic,glideSettling};
export const viewer=(ports:ImageViewerOptions):ImageViewer=>createImageViewer(ports);
export const publishedViewer=(ports:ImageViewerOptions):PublishedImageViewer=>createImageViewer(ports);
export const publishedReadings=(ports:ImageViewerOptions):ViewerResourceReadings=>createImageViewer(ports);
export const readSources=(value:PublishedImageViewer,id:string):{preview:string|null;shown:string|null}=>value.currentSources(id);
export const readPreview=(value:PublishedImageViewer,id:string):{previewDetail:{representation:string;faceTexels:number;limitation:string|null}|null}=>value.describeResources(id);
export const readPlacementFreeze=(value:PublishedImageViewer,id:string):boolean=>value.isPlacementFrozen(id);
export const warmingChoice=(value:ViewerResources,input:Parameters<NonNullable<ViewerResources["warm"]>>[0],view:Parameters<NonNullable<ViewerResources["warm"]>>[1])=>value.warm?.(input,view)??null;
export const publishedTilePreview=(value:PublishedImageViewer):NonNullable<ViewerResourceCompositionPorts["previewForTiles"]>=>input=>{
  const current=value.describeImage?.(input.id),representation=value.currentSources(input.id).preview;
  return current&&representation?{asset:{id:current.asset.id,revision:current.asset.revision},representation}:null;
};
/** A private cached atlas deliberately has no complete cube source. Returned
 * ViewerSource still exposes a complete per-acquisition source. */
export const cachedWholeSource=(value:ComposedImageSource):ComposedImageSource["source"]=>value.source;
export const resources=(ports:ViewerResourceCompositionPorts)=>createViewerResources(ports);
export const panels=(ports:ViewerPanelPorts)=>createViewerTabs(ports);
export { createBuiltInRepresentations,validateViewerAsset,createViewerSelection,VIEWER_PARAMETERS,VIEWER_SECTION_TITLES,VIEWER_EXPERIMENT_IDS,VIEWER_EXPERIMENT_PARAMETERS,preparePanorama };
export const bookkeepingId: "renderer.experiments.panoramaBookkeeping" = VIEWER_EXPERIMENT_IDS.panoramaBookkeeping;
export const opaqueImmersionId: "renderer.experiments.opaqueImmersion" = VIEWER_EXPERIMENT_IDS.opaqueImmersion;
export const panoramaShadersId: "renderer.experiments.panoramaShaders" = VIEWER_EXPERIMENT_IDS.panoramaShaders;
