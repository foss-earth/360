# Saved-media service selection

`@foss-earth/image-viewer/resources` exposes the optional port:

```ts
filesFor?(input: ViewerImageInput, representation: ImageRepresentation): ImageFileService;
```

The host owns one image session broker, one retained source cache, one renderer
uploader/transfer tracker and one saved-media store. `filesFor` chooses a common
Images file service, not a new image session. Its group is the public Images
`mediaGroup(input.asset, representation)`; different asset revisions or
representations can use the same URL without sharing saved files. The original
Earth loader selected that group for both whole files and tile files.

Minimal host composition, with the existing `broker`, `mediaStore`, browser
transport/codec and current transfer policy supplied explicitly:

```ts
import { mediaGroup } from "@foss-earth/images";
import { createImageFileService, type ImageFileService } from "@foss-earth/images/browser";
import type { ViewerResourceCompositionPorts } from "@foss-earth/image-viewer/resources";

const services = new Map<string, ImageFileService>();
const filesFor: NonNullable<ViewerResourceCompositionPorts["filesFor"]> =
  (input, representation) => {
    const group = mediaGroup(input.asset, representation);
    let service = services.get(group.id);
    if (!service) {
      service = createImageFileService({
        broker, limits: transferLimits, priority: () => 0,
        fetch: browserFetch, decode: decodeBitmap,
        cache: { files: mediaStore.files(group), settled: () => mediaStore.settled() },
      });
      services.set(group.id, service);
    }
    return service;
  };
```

Service selection happens inside a new cached source's factory. A cached source
retains its original group and calls no new selector on another placement's
reference. Whole-image obtain/decode and tiled child obtain/decode use the selected
service. The recursive tiled fallback starts its own cube factory and selects its
preview group. Sharing the actual broker preserves common request/decode queues,
reservations, cancellation and generation invalidation. Source selection, resource
algorithms, upload holds, source keys, rendering and settings are unchanged.

Preview-sheet acquisition is independent: `PreviewSheetFile` carries `mediaGroup`
explicitly, so the supplied Preview Sheets obtain port selects a common service
for that group. Its decode port must use the service that obtained the encoded
body; preserve that association when handling concurrent groups. Never infer a
group from a URL or an asynchronous global "current group" variable.

## Tiled fallback ownership

The original Earth `acquireTiled` holds an atlas and a cube preview independently
for each acquisition. During warming and refinement it uses the caller's actual
held preview; otherwise it uses the first declared complete cube preview. It
never asks the sharper-preview chooser to allocate another fallback. The public
resource composition preserves that behavior with this optional host reading:

```ts
previewForTiles?(input: ViewerImageInput, representation: TiledCubeRepresentationRecord): {
  asset: { id: string; revision: string };
  representation: string;
} | null;
```

The host returns only the viewer's actually published preview, including its
published asset identity. The owner validates the asset/revision and resolves
the declared preview-cube record itself. A stale revision, foreign asset, absent
reading or missing/non-preview representation uses the first declared complete
cube preview. Hidden preparation and pending sharper inputs are excluded by the
actual public viewer reading. The minimal adapter is:

```ts
previewForTiles(input) {
  const published = viewer.describeImage?.(input.id);
  const representation = viewer.currentSources(input.id).preview;
  return published && representation ? {
    asset: { id: published.asset.id, revision: published.asset.revision },
    representation,
  } : null;
}
```

Each tiled acquisition joins the actual atlas cache and separately acquires that
cube through the same common cache, broker and group-specific service. The cube
uses non-overlap admission as before. Both acquisitions settle before a complete
source is returned; failed acquisition cleans every fulfilled hold in
atlas/preview order and retains causal errors ahead of cleanup errors. Release
and replacement settlement are idempotent and attempt both holds even if one
supplied release fails. Generation/current checks cover both. A cancelled
nonabortable cube upload keeps its actual decoded inputs charged until native
output cleanup and input retirement have completed.

The private cache entry for tiles exposes `source: null` plus its `tiles`
atlas/table textures. It owns no preview handle or complete drawing source.
`ComposedImageSource.source` is consequently nullable; whole entries remain
complete. Every returned `ViewerSource.source` stays complete and unchanged.
Its texture is the preview held by that acquisition, so a reused atlas can be
combined with a newly published preview without keeping the old one. Once all
users release, atlas and cube independently enter the common idle LRU and each
GPU cost is counted; the atlas cannot pin a supposedly idle fallback. This is a
deliberate correction to the earlier staged cached-fallback adapter, not a leaf
spatial algorithm or cache-policy change.

`tests/tiledFallback.test.ts` and the actual installed runtime fixture use the
real public common file service, broker, decoded retention and source cache.
They prove actual viewer publication/private preparation/replacement, first
declared fallback for absent/stale/foreign readings, one atlas reused with new
fallback, exact live/idle references and GPU sums, all-attempt ordered throwing
release/settlement, and cancelled upload's late throwing output/input cleanup
with final empty grants. Injected textures and atlas adapters exercise lifecycle
only; no native GPU qualification is claimed. Original assertion bodies remain
retained. The strict installed declaration fixture assigns this exact optional
port and the nullable private cache-source type.

Omit `filesFor` to preserve the existing fixed `files` service path. The existing
resource-composition fixture exercises that compatibility path unchanged. New
source and actual installed fixtures use five group-specific common services with
one real broker, reused face URLs under two revisions and two representations,
an actual tiled owner with its recursive preview, bounded saved reads, cache
sharing for a repeated placement, final empty reservations and no default/network
calls. The strict installed declaration fixture assigns the real optional port
type. The original installed guards and assertions remain intact.

The actual factory also returns `PublishedImageViewer` with resource observations:
`currentSources(id)` returns actual live published preview/shown IDs, while
`describeResources(id).previewDetail` returns the successful published preview's
ID, owner face density and retained choice limitation. Hidden prepared entries,
pending sharper inputs, private tiled fallback identities and cancelled/stale
sources are excluded. These readings expose no source handle or new ownership.
`isPlacementFrozen(id)` observes the actual published placement freeze, allowing
the host ground watcher to skip sampling while entering/immersive transitions
freeze the marker, instead of inferring that condition from public phase labels.
For selection of a prepared replacement, guard the placed ID's published asset
identity and revision before using its residency:

```ts
current(input) {
  const published = viewer.describeImage?.(input.id);
  if (!published || published.asset.id !== input.asset.id ||
      published.asset.revision !== input.asset.revision) {
    return { preview: null, shown: null };
  }
  return viewer.currentSources(input.id);
}
```

The legacy `ImageViewer` structural contract is unchanged; new actual factories
provide the exported `ViewerResourceReadings` contract through
`PublishedImageViewer`. Source and installed fixtures retain original assertions
and add causal hidden/cancelled/late/private-source publication observations.

## Entry tile warming

`ViewerResources.warm?(input, view)` is an optional selector for an admissible
tiled representation of the opening view. `createViewerSelection` delegates to
its existing preference, device and common admission policy and returns only a
tiled result. `createViewerResources` applies the same resolved source/cache key
as immersion acquisition. Existing handwritten resource ports without `warm`
retain their previous behavior.

The actual viewer starts that source at priority 5 with replacement overlap
during the original flight, expansion or fade entry. It asks the supplied pose
port for the panorama's opening presentation and feeds the warmed source's tile
frame callback through the viewer's existing `onFrame`, with that virtual view,
the actual image content rotation and the same host timestamp. It creates no
frame subscription, scheduler, uploader, broker, cache or rendering hold.

Once immersion asks for the same keyed source, a ready warming hold transfers
directly. When acquisition is still pending, immersion joins the common cache
at priority 10 before the warming waiter is cancelled. This ordering also
preserves one allocation with a zero kept-GPU budget. Cancellation, replacement,
image disposal and viewer disposal stop the warming waiter and release its
hold. Actual native output that returns late is retired by the common cache and
its scope; the injected loader must keep native inputs/allocations until that
retirement, including across an unabortable wait. Ordinary warming acquisition
failure remains silent so the immersive acquisition reports its real failure,
as in the original Earth behavior. Warming never publishes a preview, shown
identity or private fallback as a public image resource observation.

`tests/warming.test.ts` and the actual installed consumer fixture exercise the
public viewer with the real common broker, source cache and reservations. They
cover flight and expansion virtual frames, ready hold transfer, pending-load
joining, cancelled entry's retained allocation until late output disposal,
one source allocation, replacement-overlap settlement and final empty grants.
Their injected texture is a lifecycle fixture, not a GPU/device qualification.
The selection and resource fixtures also require a tiled-only warming choice
and the exact same resolved key as immersion acquisition. Every prior assertion
body is retained. This source increment remains UNRUN until the primary's grant.

This increment is SOURCE ONLY / UNRUN. The primary agent must reserve and execute
owner and actual installed-consumer checks, pack a new exact artifact and record
consumer adoption before accepting it. No current artifact or admission pin is
implied. Rollback removes this optional port and host adoption together; prior
fixed-service callers and prior exact source/artifact evidence remain available.
Reverting the tiled-fallback correction also restores the earlier private cache
shape; roll back its host/type adoption together. That earlier staged shape is
retained evidence, not faithful behavior accepted for final migration.
