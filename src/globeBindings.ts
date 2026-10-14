/** Optional Engine-to-360 adapter. Imports create no device/broker/DOM/clock. */
import { levelUp, orbitAngles, orbitLook, pointGeodetic, glideSettling, enuFrame,
  viewFromPresentation, presentationFromView, ecef, type NavigationLease } from "@foss-earth/engine";
import type { GlobeRuntime } from "@foss-earth/engine/babylon";
import type { PublishedImageViewer, ViewerPosePorts, ViewerWorldMath } from "./ports.js";
import type { ViewerNavigationLease, ViewerNavigationPorts } from "./viewer.js";
import { createFeatureFramePreparation } from "@foss-earth/renderer";
import { tileAtlasLayout, tiledCubeTileCount, type TiledCubeRepresentationRecord } from "@foss-earth/sphere-tiled-cubemap";
import type { ImageRepresentation } from "@foss-earth/images";
import type { ViewerRepresentation } from "./catalogue.js";
import type { SphereRenderer } from "./renderer.js";

export type GlobeViewerRuntime = Pick<GlobeRuntime, "acquireNavigation" | "placeNavigationCamera" |
  "restoreNavigationSnapshot" | "glideNavigationCamera" | "getCameraHandling">;
export const globeViewerMath: ViewerWorldMath = { levelUp, orbitAngles, orbitLook, pointGeodetic, glideSettling };
export const globeViewerPoses: ViewerPosePorts = {
  viewFromPresentation(input, pose) {
    const capture = input.details?.capture;
    if (!capture) throw new Error("A geographic viewer input requires capture coordinates.");
    return viewFromPresentation(enuFrame(capture.longitudeDeg, capture.latitudeDeg), pose);
  },
  presentationFromView(input, view) {
    const capture = input.details?.capture;
    if (!capture) throw new Error("A geographic viewer input requires capture coordinates.");
    return presentationFromView(enuFrame(capture.longitudeDeg, capture.latitudeDeg), input.placement.marker ?? [0, 0, 0], view);
  },
};

export function createGlobeViewerNavigation(runtime: GlobeViewerRuntime, ports: { returnFocus(focus: unknown): void; isAbortSignal(signal: unknown): signal is AbortSignal; owner?: string }) {
  const leases = new WeakMap<ViewerNavigationLease, NavigationLease>();
  const engineLeaseFor = (lease: ViewerNavigationLease): NavigationLease => {
    const real = leases.get(lease);
    if (!real) throw new Error("The viewer navigation lease belongs to another host.");
    return real;
  };
  const navigation: ViewerNavigationPorts = {
    acquire() {
      const acquired = runtime.acquireNavigation({ owner: ports.owner ?? "foss-earth.scenes", inputContext: "panorama", terrain: "paused" });
      if (!acquired.ok) return { ok: false, message: acquired.message };
      const real = acquired.lease;
      if (!ports.isAbortSignal(real.signal)) {
        real.release("cancelled");
        throw new Error("Globe viewer navigation requires its native abort signal.");
      }
      const lease: ViewerNavigationLease = {
        overview: real.overview, signal: real.signal,
        get released() { return real.released; },
        setPresentationView: pose => real.setPresentationView(pose),
        holdRendering: () => real.holdRendering(),
        release: reason => real.release(reason),
      };
      leases.set(lease, real);
      return { ok: true, lease };
    },
    place(lease, pose) { runtime.placeNavigationCamera(engineLeaseFor(lease), pose); },
    restore(snapshot, lease) { runtime.restoreNavigationSnapshot(snapshot, lease ? engineLeaseFor(lease) : undefined); },
    glide(lease, pose, marker, motion) {
      runtime.glideNavigationCamera(engineLeaseFor(lease), pose, ecef(marker), {
        ...motion, velocity: ecef(motion.velocity), turn: ecef(motion.turn),
      });
    },
    inertiaDecay: () => runtime.getCameraHandling().glideKeepPerFrame,
    returnFocus(lease) {
      const focus = engineLeaseFor(lease).focusReturn;
      ports.returnFocus(focus);
    },
  };
  return { navigation, engineLeaseFor };
}

/** Actual Scenes.projectLink binding, retaining geographic heading/pitch semantics. */
export function createGlobeViewerProjection(ports: {
  viewer: Pick<PublishedImageViewer, "status" | "describeImage" | "describeResources">;
  renderer: Pick<SphereRenderer, "cameraFrame" | "project">;
  runtime: Pick<GlobeRuntime, "getPresentationView">;
}) {
  return (direction: { headingDeg: number; pitchDeg: number }): { x: number; y: number } | null => {
    const active = ports.viewer.status().active;
    const capture = active ? ports.viewer.describeImage?.(active)?.details?.capture : null;
    if (!capture) return null;
    const frame = ports.renderer.cameraFrame(ports.runtime.getPresentationView());
    if (!frame) return null;
    const presented = presentationFromView(enuFrame(capture.longitudeDeg, capture.latitudeDeg), [0, 0, 0],
      { ...direction, rollDeg: 0, verticalFovDeg: 60 });
    return ports.renderer.project([presented.forward.x, presented.forward.y, presented.forward.z], frame);
  };
}

/** Structural match for Scenes' image readings, with real representation facts. */
export interface ViewerSceneImageDescription {
  previewDetail: ReturnType<PublishedImageViewer["describeResources"]>["previewDetail"];
  images: readonly { id: string; role: "preview" | "immersion"; projection: string;
    width: number; height: number; aroundPx: number; encodedBytes: number; gpuBytes: number;
    warp?: string; tiles?: number }[];
}
export interface ViewerSceneDescriptionPorts {
  representations: readonly ViewerRepresentation[];
  tileMemoryBytes(): number;
  maxTextureSide(): number;
}
export function createViewerSceneDescription(viewer: Pick<PublishedImageViewer, "describeImage" | "describeResources">, ports: ViewerSceneDescriptionPorts) {
  return (id: string): ViewerSceneImageDescription => {
    const image = viewer.describeImage?.(id);
    return { previewDetail: viewer.describeResources(id).previewDetail,
      images: image?.asset.representations.map((record: ImageRepresentation) => {
        const owner = ports.representations.find(entry => entry.hooks.projection === record.projection);
        if (!owner) throw new Error(`No representation owner for ${record.projection}.`);
        const density = owner.faceTexels(record), tiled = record.projection === "tiled-cube" ? record as TiledCubeRepresentationRecord : null;
        const gpuBytes = tiled ? tileAtlasLayout(tiled, ports.tileMemoryBytes(), ports.maxTextureSide())?.gpuBytes ?? 0
          : owner.hooks.estimate(record, { maxTextureSide: Infinity }).sourceGpu;
        return { id: record.id, role: record.role, projection: record.projection,
          width: density * (record.projection === "equirectangular" ? 4 : 1), height: density * (record.projection === "equirectangular" ? 2 : 1),
          aroundPx: density * 4, encodedBytes: record.encodedBytes, gpuBytes,
          ...(tiled ? { warp: tiled.warp, tiles: tiledCubeTileCount(tiled) } : {}) };
      }).sort((a, b) => a.aroundPx - b.aroundPx || a.gpuBytes - b.gpuBytes) ?? [] };
  };
}

/** Connect once to Engine.framePreparation; overlay frames reuse the host subscription. */
export function createGlobeViewerFrameBinding(ports: {
  viewer: Pick<PublishedImageViewer, "onFrame" | "describeImage" | "describeResources">;
  isCurrent(): boolean; requestRender(): void;
  frames: { subscribe(listener: () => void): () => void };
  description: ViewerSceneDescriptionPorts;
}) {
  return {
    framePreparation: createFeatureFramePreparation({ onFrame: frame => ports.viewer.onFrame(frame),
      isCurrent: () => ports.isCurrent(), requestRender: () => ports.requestRender() }),
    frames: { subscribe: (listener: () => void) => ports.frames.subscribe(listener) },
    describeImage: createViewerSceneDescription(ports.viewer, ports.description),
    describeResources: (id: string) => ports.viewer.describeResources(id),
  };
}
