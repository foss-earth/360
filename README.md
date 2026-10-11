# @foss-earth/360

Local 0.1.0 staging source extracted from Earth revision
`90e23b3ee96f53ec5900afc5991a21fffa58649d`. This source has no new qualified
checks, accepted artifact, shared CI caller or remote admission receipt.

The pure root/core exports viewer contracts, orb/window ray mathematics, look
and flight models, built-in owner hook composition, representation selection and
geographic-heading interpolation. Importing them initializes no DOM, React,
renderer, network session or clock. Engine geography is supplied through
`ViewerWorldMath`/`ViewerPosePorts`. Scene documents, placements, history and
navigation topology remain scenes-owned.

`./viewer` exports `createImageViewer`. Inject the existing renderer, resources,
navigation/input/pose/world ports, settings, cancellation, occlusion and clock/frame
authority. `prepare(input, signal)` freezes authored metadata and prepares a hidden
orb. `ready()` waits for a live source and rejects disposal. `replaceImages(handles)`
validates the entire next publication before changing visible metadata; the host
immediately disposes outgoing handles. Internal draw IDs distinguish old/new sets
with duplicate authored IDs. `describeImage(id)` exposes immutable metadata for
an injected details panel. `enter`, `exit`, `activateAction`, `pick`, `hover`,
`subscribe`, `status`, `onFrame` and `dispose` retain the public lifecycle. Scenes
supplies activation callbacks; the viewer never resolves scene entities. Cancelled
flights hand position, velocity, turn and fresh gestures to the one host camera glide.

The factory returns `PublishedImageViewer` (the compatible `ImageViewer` plus
`ViewerResourceReadings`). `currentSources(id)` observes actual published preview
and currently shown representation IDs; `describeResources(id).previewDetail`
observes the retained preview ID, owner density and limitation from its successful
choice. Hidden preparation, private incoming/borrowed sources, cancelled/disposed
entries and stale generations are absent. Reading them creates no resource, draw,
subscription or policy change. `isPlacementFrozen(id)` reads the actual published
entry freeze so a displayed-ground watcher can retain its original query guard.
Legacy structural `ImageViewer` implementations
remain valid without fabricated readings. When adapting selection for a prepared
replacement with a reused placed ID, first compare `describeImage(id).asset` ID and
revision with the input before using residency from the published image.

`./resources` exports `createViewerResources`. Supply the same images broker,
`createImageSourceCache`, file service, renderer uploader and `atlasDevice` region
adapter. Cubemap/equirectangular own acquisition, spatial conventions and uploads;
preview-sheets supplies optional shared face sources and six-file fallback;
tiled-cubemap owns layout, selected tiles, its scheduler and table. Upload tickets
reserve directly in broker pools and outlive operation cancellation. Source holds
keep fallback previews alive. Replacement overlap settles only after outgoing
release, including borrowed previews during interrupted flight outros. Cache keys
retain resolved URL order, broker generation and atlas layout. The host pumps its
existing uploader and transfer tracker once per frame and calls viewer `onFrame`.
No renderer, broker, upload queue, private clock or frame subscription is created.

An optional `filesFor(input, representation): ImageFileService` selects the common
file service bound to `mediaGroup(input.asset, representation)`. A host can memoize
these lightweight services per group and supply `mediaStore.files(group)` to each,
while all of them share its existing broker, transport and decoder. Selection runs
inside the source factory, once per new cached source; a cached source keeps its
original group. Tiled sources select their tile group and recursively acquired cube
previews select their own preview group. Preview sheets independently supply the
explicit `PreviewSheetFile.mediaGroup` to their injected common service. A URL is
not a media-group identity: different asset revisions or representations may reuse
it. Omitting `filesFor` keeps the original fixed `files` service behavior. This
source increment and its source/installed fixtures are prepared, unexecuted.

Incoming tiled sources use that same frame through coverage waits and crossfades.
Tiles over a preview appear immediately with the preview as fallback; a sharper
whole image remains until its replacement covers the current view. While the view
moves during a fade, fallback pixels can show while newly requested tiles arrive;
final publication rechecks latest coverage. Network/decode waiting adds no continuous
render lease. A source made stale by broker invalidation cannot remain the active
preview: liveness/key checks reload it, and invalidate an immersive navigation hold.

`createViewerSelection` retains preview-size bounds, density, image-detail cap,
format preference, admission fallback and failure exclusion. Supply owner density/
estimate hooks, current published IDs, user settings, device limits and common
cache/broker admissibility. `createBuiltInRepresentations` composes the public leaf
validators; `validateViewerAsset` requires a validated complete cube preview. No
leaf validator or spatial format algorithm is copied here.

`./settings` exports `VIEWER_PARAMETERS`/`VIEWER_SECTION_TITLES` with the exact
original appearance, motion and active-image IDs/homes/bounds/defaults/reasons.
It also exports `VIEWER_EXPERIMENT_IDS`/`VIEWER_EXPERIMENT_PARAMETERS` for the
three existing panorama bookkeeping, opaque immersion and shader experiments.
Those records are included once in `VIEWER_PARAMETERS`, with their original
`renderer.experiments.*` IDs, off defaults, text, source attribution and no numeric
bounds. Their existing home remains Renderer → Work-saving experiments, a
feature contribution to that tab. The generic Renderer owns the section and
its `all`/`presentationCandidates` records; register those from Renderer alongside
360's records in the one host registry. Do not also register the temporary
Renderer `LEGACY_360_RENDERER_PARAMETER_HANDOFF`. This package's settings entry
imports no Renderer implementation and creates no registry or rendering work.
Scenes keeps content controls, images loading/saved controls, tiled-cubemap tile
controls including `tileOutlines`, and preview-sheets `previewSheets`. Register
contributions in the one host registry; this package never registers globally.
`./panels` exports `createViewerTabs` with injected document, UI sections/parameter
adapters, generic image/details readings and tab activation. Stable `panorama` and
`panorama-settings` IDs remain unchanged; closing calls exit. `./input` takes explicit
window, control-key and wheel-classifier ports; detached handlers remain inert.
`./babylon`, `./shaders` and `./shaders-webgl` retain orb/reveal/immersion rendering
on the host scene, with explicit experiments off by default.

`./preparation` (also `./node`) exports `preparePanorama(argv, ports)`. `./prepare-cli`
and `foss-earth-prepare-panorama` preserve local-file arguments, authored/GPano pose
and mandatory credit, dated owner `build/prepared-scenes` output, preview/whole/tiled
files and fragment/provenance outputs. Normalization, source eligibility, sampling,
cube/tile rendering and encoders are public owner APIs. Revision inputs/tool version
1 retain the original intended bytes; exact split-artifact byte comparison is pending.
Component entry digests replace monolithic `libSha256`. No network is used. Scene
publication checking belongs in scenes: an exact prepared transfer is retained under
`fixtures/transfers/scenes-node`, excluded from runtime exports/dependencies/artifacts.

Prepared fixtures cover retained math/flight/look/input, hidden publication, immutable
metadata, late cancellation, stale navigation/refinement, interrupted momentum/outro
settlement, idle render authority, resource refcounts/overlap, tabs and public Node
preparation. Engine-only orbit/decay and leaf conventions remain their owners' tests.
The world fixture imports public engine exports only; production 360 imports no engine.

The optional resource `warm(input, view)` selector preserves the original tiled
entry preparation during flight, expansion or fade. The viewer ticks it with the
virtual opening view on the existing host frame and transfers a ready source hold
or joins a pending common-cache load before cancelling its warming waiter. It
creates no additional renderer, cache, broker, scheduler or rendering hold.
Published source readings exclude this private work. The [resource contract](docs/saved-media-services.md)
documents cancellation, late retirement and the exact public fixture scope.
Tiled source acquisitions take an independent cube-preview hold: optional
`previewForTiles` supplies actual published asset/revision/preview identity, or
the first declared complete cube preview is used. The cached atlas owns no
fallback reference, so reusing it with a changed preview cannot retain a private
fallback or add another atlas allocation. The host's existing broker and cache
still own admission, cancellation, generations and idle retention.

Refinement commits a successfully displayed incoming source before attempting
outgoing release and replacement settlement. All cleanup calls are attempted;
their failures report in operation order while the displayed source retains its
cache hold. If the final display fails before publication, restoration and incoming
release are both attempted, preserving display, restoration and release errors
in order. `tests/refinementSettlement.test.ts` and the actual installed consumer
fixture use the common Images broker/cache and real scope grants: preview 24 bytes,
outgoing 64 bytes and incoming 128 bytes. Throwing wrappers run only after actual
release/settlement. The fixtures check live source identities, reservations,
overlap, disposal counts and final complete cleanup. Injected texture objects are
lifecycle fixtures; they make no GPU/device qualification claim. This new
regression increment is source-only and has not been executed.

In a reserved window, primary should install exact independently packed owner
artifacts, run `npm run ci` once, then `npm run test:consumer --
--artifacts=build/artifacts/consumer-dependencies.json`. The latter expects an array
of `{name, version, archive, sha256}` records (paths relative to that input), including
complete exact optional/tool dependencies. It packs 360, uses owner `build/npm-cache`
offline, rejects imports outside the installed workspace, checks pure imports,
injected viewer/panel cleanup, preparation/CLI and strict public declarations, and
retains a dated receipt. No sibling source fallback is permitted. These checks are
prepared only and have not run.

Before adoption rollback is the unchanged old Earth implementation. After staged
adoption restore the old composition/barrels/catalogues and exact prior lockfile
pins together. Preserve revision/URL identity, navigation ownership, one renderer/frame
and outgoing disposal order. Actual Earth/Flight/Campus adoption, full split checks,
filtered lineage, pinned shared CI/conformance, rights review and remote admission
remain primary/coordinator acceptance blockers.

## Project policies

- [Code of conduct](https://github.com/foss-earth/.github/blob/main/CODE_OF_CONDUCT.md)
- [Contributing](https://github.com/foss-earth/.github/blob/main/CONTRIBUTING.md)
- [AGPL-3.0 license](LICENSE)
- [Security](https://github.com/foss-earth/.github/blob/main/SECURITY.md)
