import type { ImageAsset, ImageAttribution, ImagePose, ImageRepresentation, Mat3, Vec3 } from "@foss-earth/images";
import type { LookState } from "./look.js";

/** Structural world ports; the viewer never imports a globe implementation. */
export interface ViewerWorldMath {
  levelUp(forward: Vec3, vertical: Vec3, fallback: Vec3): Vec3;
  orbitAngles(center: Vec3, forward: Vec3, fallbackYaw: number): { yaw: number; pitch: number };
  orbitLook(center: Vec3, yaw: number, pitch: number): Vec3;
  pointGeodetic(point: Vec3): { longitudeDeg: number; latitudeDeg: number; heightMeters: number };
  glideSettling(keepPerFrame: number): { durationMs: number; settled(ms: number): number };
}
export interface ViewerNavigationSnapshot {
  readonly version: 1;
  readonly view: { latDeg: number; lonDeg: number; headingDeg: number; pitchDeg: number; zoomMeters: number };
  readonly camera: { center: { x: number; y: number; z: number }; yaw: number; pitch: number; radius: number; fov: number };
}
export interface ViewerNavigationPresentation {
  readonly position: { x: number; y: number; z: number };
  readonly forward: { x: number; y: number; z: number };
  readonly up: { x: number; y: number; z: number };
  readonly verticalFovRad: number;
}
export interface ViewerImageAction {
  id: string;
  label: string;
  direction?: { headingDeg: number; pitchDeg: number };
  /** Host resolves the action target; no scene/entity lookup in the viewer. */
  activate(): Promise<boolean> | boolean;
}
export interface ViewerImageInput<R extends ImageRepresentation = ImageRepresentation> {
  /** A placed-image identity, independent of the asset's revision identity. */
  id: string;
  asset: ImageAsset<R>;
  pose: ImagePose & { aligned?: boolean };
  placement: {
    /** Resolved host-space metres; null while the host's surface is missing. */
    marker: Vec3 | null;
    radiusMeters: number;
    /** Host-space to image-local rotation, prepared by the host world adapter. */
    content: Mat3;
    outline: { color: readonly [number, number, number, number]; widthPx: number } | null;
    hoverScale: number;
  };
  title: string;
  description?: string;
  credits: ImageAttribution;
  initialView?: LookState;
  actions: readonly ViewerImageAction[];
  /** Optional authored text/data for the details tab; never consulted for navigation. */
  details?: { capture?: { latitudeDeg: number; longitudeDeg: number; heightMeters: number | null; horizontalAccuracyMeters: number | null }; groups?: readonly string[] };
}
export type ViewerPhase = "overview" | "preparing" | "entering" | "immersive" | "exiting" | "disposed";
export interface ViewerLook extends LookState { rollDeg: number }
/** Geographic frames belong to the host; image-local rotation is not a north reference. */
export interface ViewerPosePorts {
  viewFromPresentation(input: ViewerImageInput, presentation: ViewerNavigationPresentation): ViewerLook;
  presentationFromView(input: ViewerImageInput, view: ViewerLook): ViewerNavigationPresentation;
}
export interface ViewerImageDetail { representation:string;loading:string|null;limitation:string|null;progress?:readonly string[] }
export interface ViewerStatus {
  phase: ViewerPhase; active: string | null; target: string | null;
  view?: LookState | null;
  immersionDetail?: ViewerImageDetail | null;
  credits?: readonly (ImageAttribution & { assetId: string })[];
  lastError?: string | null;
  renderingAvailable?: boolean;
  unavailableReason?: string | null;
}
/** Image lifecycle implemented by the optional host-bound viewer. */
export interface PreparedViewerImage {
  readonly id: string;
  ready(): Promise<void>;
  updatePlacement(placement: ViewerImageInput["placement"]): void;
  hover(active: boolean): void;
  dispose(): void;
}
export interface ViewerAbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
export interface ImageViewer {
  prepare(input: ViewerImageInput, signal: ViewerAbortSignal): Promise<PreparedViewerImage>;
  /** Atomic metadata publication. Drawing reveals only ready resources. */
  replaceImages(images: readonly PreparedViewerImage[]): void;
  enter(id: string, options?: { signal?: ViewerAbortSignal; view?: LookState }): Promise<boolean>;
  exit(): void;
  status(): ViewerStatus;
  describeImage?(id: string): ViewerImageInput | null;
  subscribe(listener: (status: ViewerStatus) => void): () => void;
  pick(clientX: number, clientY: number): readonly string[];
  hover(id: string | null): void;
  activateAction(id: string): Promise<boolean>;
  /** Same host clock/frame used by renderer and navigation. */
  onFrame(frame: { now: number; dtMs: number }): boolean;
  dispose(): void;
}
/** Actual published residency and placement freeze, for host selection and scene details. These are
 * observations only: prepared/private/cancelled/stale sources are never exposed. */
export interface ViewerResourceReadings {
  /** Allows the original displayed-ground watcher to avoid querying while a
   * transition has frozen this published placement; no phase inference. */
  isPlacementFrozen(id: string): boolean;
  currentSources(id: string): { preview: string | null; shown: string | null };
  describeResources(id: string): {
    previewDetail: { representation: string; faceTexels: number; limitation: string | null } | null;
  };
}
/** The supplied factory adds readings without requiring legacy structural
 * ImageViewer implementations to invent resource observations. */
export type PublishedImageViewer = ImageViewer & ViewerResourceReadings;
