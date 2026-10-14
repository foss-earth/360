import { createGlobeViewerNavigation, createGlobeViewerProjection, createGlobeViewerFrameBinding, createViewerSceneDescription, globeViewerMath, globeViewerPoses, type GlobeViewerRuntime } from "@foss-earth/image-viewer/globe";
import { createGlobeViewerInput } from "@foss-earth/image-viewer/globe-browser";
import { createImageViewer } from "@foss-earth/image-viewer/viewer";
import { createViewerResources } from "@foss-earth/image-viewer/resources";
import type { SettledPublishedImageViewer, ViewerWorldMath, ViewerPosePorts } from "@foss-earth/image-viewer";
import type { LoadSceneOptions } from "@foss-earth/scenes/browser";
export const worldMath: ViewerWorldMath = globeViewerMath;
export const poses: ViewerPosePorts = globeViewerPoses;
export function navigationContract(runtime: GlobeViewerRuntime, ports: Parameters<typeof createGlobeViewerNavigation>[1]) { return createGlobeViewerNavigation(runtime, ports); }
export function inputContract(...input: Parameters<typeof createGlobeViewerInput>) { return createGlobeViewerInput(...input); }
export function sceneContract(frames: Parameters<typeof createGlobeViewerFrameBinding>[0], projection: Parameters<typeof createGlobeViewerProjection>[0]) {
  const bound = createGlobeViewerFrameBinding(frames);
  const scenes: Pick<LoadSceneOptions, "frames" | "describeImage" | "projectLink"> = {
    frames: bound.frames, describeImage: bound.describeImage, projectLink: createGlobeViewerProjection(projection),
  };
  const description: NonNullable<LoadSceneOptions["describeImage"]> = createViewerSceneDescription(frames.viewer, frames.description);
  return { scenes, description, framePreparation: bound.framePreparation };
}
export function viewerContract(input: Parameters<typeof createImageViewer>[0]): SettledPublishedImageViewer { return createImageViewer(input); }
export function resourceContract(input: Parameters<typeof createViewerResources>[0]) {
  const resource = createViewerResources(input); resource.retire(); return resource.whenSettled();
}
