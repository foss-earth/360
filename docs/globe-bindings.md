# Globe panorama adapters

Status: implemented source draft; public consumers and regressions UNRUN.

`@foss-earth/sphere-image/globe` is an optional Engine-to-viewer adapter. Engine never
imports 360. The existing pure root, viewer and representation contracts remain
available; importing the optional entry creates no device, broker, clock or
viewer. Its Engine peer uses the existing exact owner version and is optional.

- `globeViewerMath` and `globeViewerPoses` supply the existing orbit/ENU and
  geographic capture-pose transforms.
- `createGlobeViewerNavigation(runtime, { returnFocus, isAbortSignal, owner? })`
  returns `navigation` and `engineLeaseFor`. It uses Engine's actual navigation
  lease, terrain pause/input context, rendering hold, inertia, momentum handback,
  native cancellation and original focus return. Foreign leases are refused.
- `createGlobeViewerProjection({ viewer, renderer, runtime })` returns the real
  authored direction → panorama CSS projection, or null without an active
  capture/camera frame. It uses `renderer.cameraFrame` and `renderer.project`.
  Scenes' current public hook is `LoadSceneOptions.projectLink`; there is no
  `projectAction` API. No projection algorithm is copied into a host.
- `createViewerSceneDescription(viewer, { representations, tileMemoryBytes,
  maxTextureSide })` supplies typed `previewDetail` and `SceneImageStatus` facts:
  dimensions, density, encoded/GPU bytes and tiled warp/count come from actual
  representation owners and bounded atlas layout. Hosts supply their existing
  registry/budgets. No Scenes dependency enters the 360 implementation.
- `createGlobeViewerFrameBinding({ viewer, isCurrent, requestRender, frames,
  description })` returns Renderer `framePreparation`, the borrowed `frames`,
  `describeImage` and `describeResources`. Supply `description` explicitly;
  `describeResources` alone is not the Scenes description contract. This
  adapter never registers an additional frame subscription.

`@foss-earth/sphere-image/globe-browser` exports
`createGlobeViewerInput(runtime, canvas, engineLeaseFor, ports)`. `ports` supplies
monotonic time, key ownership, abort reason and optional signal/error channel.
The result supplies `input`, `wheels`, `dispose`. Actual look-input, native
navigation intents, held press and fresh-wheel cancellation behavior are retained.
Every attached listener is released on abort/disposal; partial attachment and
throwing cleanup remain observable. There is no ambient canvas/window/session on
import.

Image anchor markers are optional and off by default in **360 image settings →
Looking → Show anchors** (`scene.panorama.showAnchors`). The browser input
`anchorMarkers` port accepts an `enabled` reader, a `create(element)` renderer
factory and an optional settings subscription for immediate changes. Pass
`createImageAnchorMarkers(element, surfaceRect?)` from the same browser entry
to reuse the map's grab arrows, zoom reticle and gray glide state. Its positions
are local CSS pixels in the measured surface; the helper converts them to client
pixels and hides points outside that surface. The same factory works inside a
preview iframe using its own document.

A two-finger trackpad swipe turns heading and pitch directly by its scroll
deltas scaled by `swipeSensitivity` and $\tan(\text{fov}/2)$, gliding with the
look model's inertia regardless of cursor position, and shows no
anchor marker. The [gesture guide](gesture-anchors.md) records the camera
invariants, timing, viewport units and regression coverage.

`createImageViewer` in `@foss-earth/sphere-image/viewer` returns additive
`SettledPublishedImageViewer`, with `whenSettled(): Promise<void>`; it accepts a
host `signal` and optional `onRetirementError`. `createViewerResources` in
`@foss-earth/sphere-image/resources` returns `SettledViewerResources`, including `retire`
and `whenSettled`. Resources borrow the existing Images broker/source cache/files,
Renderer uploader/region device and Preview sources. The host retires its cache,
previews and features too. Late decode/acquisition is actually awaited and released;
late throwing releases are retained. Native uploader proof is never replaced by
a resolved placeholder.

## Minimal Scenes adoption

```ts
import { createGlobeViewerFrameBinding, createGlobeViewerProjection,
  createGlobeViewerNavigation, globeViewerMath, globeViewerPoses }
  from "@foss-earth/sphere-image/globe";
import { createGlobeViewerInput } from "@foss-earth/sphere-image/globe-browser";

const nav = createGlobeViewerNavigation(globe, focusPorts);
const input = createGlobeViewerInput(globe, canvas, nav.engineLeaseFor, inputPorts);
// The host's one viewer receives nav.navigation, input.input, the same broker,
// existing resources/native uploader, globeViewerMath and globeViewerPoses.
const frame = createGlobeViewerFrameBinding({ viewer, isCurrent, requestRender,
  frames: existingFrames,
  description: { representations, tileMemoryBytes, maxTextureSide } });
const sceneHooks = { frames: frame.frames, describeImage: frame.describeImage,
  projectLink: createGlobeViewerProjection({ viewer, renderer: panorama, runtime: globe }) };
// Engine's one framePreparation invokes frame.framePreparation.prepare once.
```

Campus retains authored overview/placement/content and passes these hooks to
its existing Scenes composition. Its `prepare` path returns one usable native
session. Abort begins viewer/resources/Engine/Renderer retirement; its truthful
`whenSettled` awaits each owner, then the final borrowed-device marker before
`dispose` releases the device. A report-only path uses UI and creates no viewer.

The extraction comes from Earth App `sceneWorld.ts`, `sceneHost.ts` and
`framePreparation.ts`, recorded with original hashes/modes and preserved lineage.
No Campus assets/constants or authored SceneWorld placement moved into shared
code. Authored fixtures cover geographic projection, real lease/focus/inertia,
foreign lease rejection, held input, one frame, actual representation costs,
delayed late decoder/source release and throwing cleanup. Public strict consumers
also prove structural assignment to the accepted Scenes hooks. Exact package
qualification, Campus/App adoption and real browser WebGL1/2 remain pending.
