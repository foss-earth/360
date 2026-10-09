# Panorama controller and source-dependent tile ports

The pure `@foss-earth/360` and `@foss-earth/360/core` entries now export:

```ts
const PANORAMA_GAMEPAD_ACTIONS: readonly ActionDescriptor[];
interface PanoramaProfileContribution {
  readonly contexts: readonly string[];
  bindings(slot: number, deadzone: number): readonly BindingSpec[];
}
function createPanoramaProfileContribution(
  transform: Readonly<BindingTransformSpec>,
): PanoramaProfileContribution;
```

Only gamepad-tools public core types are imported by this module. The host
supplies its common transform, selects the controller slot and uses its existing
named `input.gamepad.deadzone`. No second controller driver, input frame, clock,
controller policy or renderer authority is initialized. Host composition uses
the released public contracts:

```ts
import { DEFAULT_BINDING_TRANSFORM } from "@felipegalind0/gamepad-tools/core";
import { PANORAMA_GAMEPAD_ACTIONS, createPanoramaProfileContribution } from "@foss-earth/360";
import { createGlobeGamepadAdapter, createStandardGlobeProfile } from "@foss-earth/engine/gamepad";

const contribution = createPanoramaProfileContribution(DEFAULT_BINDING_TRANSFORM);
const profile = createStandardGlobeProfile(slot, deadzone, contribution);
const adapter = createGlobeGamepadAdapter(target, {
  featureActions: PANORAMA_GAMEPAD_ACTIONS,
  getContext: () => navigation.currentContext(),
});
```

`target`, `navigation`, `slot` and `deadzone` in this example are host-owned ports
and values. The navigation owner selects the panorama context and forwards
intents to the existing `attachLookInput` handler. That handler's momentum,
gesture, key ownership, frame request and detach behavior remain unchanged.

The four original descriptors retain their complete IDs, labels, category,
rate/command kind, ranges, availability and `panorama` context. The four original
binding IDs retain enabled=true, precedence=0 and their original transforms:
right-stick axis 2 controls `panorama.lookX`; axis 3 with inversion controls
`panorama.lookY`; paired buttons 7/6 control `panorama.zoom`; button 1 is the
`panorama.exit` command. Axis transforms receive the host's supplied deadzone.
The zoom and exit transforms retain their original [0,1] input ranges and
[-1,1]/[0,1] output ranges. All other fields come from the actual supplied
gamepad-tools transform, preserving the original shared-default boundary.

This data is extracted from the actual retained committed Earth revision
`90e23b3ee96f53ec5900afc5991a21fffa58649d` `src/input/globeNavigation.ts`:
blob `9f86376a5e0533951de80fe98c34ea6eb434aafc`, 9,444 bytes, SHA256
`08a986bd4b559d5587d7b4f9723aa85389aa2c82033811430df248b747bcae31`.
Those exact original bytes and all 60 intake files are retained under this
owner's ignored `build/source-only/2026-10-09T19-43-00Z-panorama-controller-contributions/`.
Its before-manifest SHA256 is
`2687da06f93fe9e32cd0b6df6338e70b00adbc307b8cbff2f7e8a6e22ee7e91f`.
The existing `SOURCE_LINEAGE.json` and all human notices remain unchanged;
the primary still needs to include this newly selected source path in the
complete clean publication lineage before release.

The optional resource composition also corrects its host tile-policy port:

```ts
tiles.selection(representation: TiledCubeRepresentationRecord): TileSelectionParameters;
```

The actual current representation is supplied on every existing tile frame.
The original `tileParameters(representation)` computed its finest level from
`levelBytes.length - 1` and its image-detail level cap from the named
`scene.panorama.immersionWidth` divided by `4 * representation.tileSize`.
A callback with no representation could not preserve that behavior for different
pyramids. Policy remains host-supplied and tile selection stays in tiled-cubemap;
360 forwards the result without copying either algorithm. Existing callbacks
that ignore arguments retain their runtime behavior. Hosts needing the original
per-source cap should adopt the representation argument.

Actual original `src/scenes/loadScene.ts` bytes are retained alongside the
controller input: blob `7d5545e0945f42a4b1999db4c8f78b608ada7ce0`, 130,968 bytes,
SHA256 `0e326ec830c0056684cbc82884a520592859a0152a70c02dab5265498b0e3b51`.
Only the two resource signature/call sites change. Viewer/look/flight algorithms,
settings IDs/defaults and all original test assertions remain unchanged.

The actual archive consumer fixture checks full descriptors, all binding fields,
default slot/deadzone and supplied slot/deadzone through the public Engine profile
and action adapter. Its root/core imports run while DOM globals are poisoned and
controller/Engine runtime imports are denied, with an explicit negative control.
Its strict declaration fixture checks the Engine contribution/feature-action
ports and representation-aware tile callback. The installed runtime fixture also
composes actual public 360 resources, Images broker/cache/file service and the
real tiled owner with supplied CPU boundaries. Two different tile sizes require
level caps [1,0]; changing the named image-width fixture requires [2,1], with
exact record identities and public delivered-detail assertions. This verifies
the delegated port shape when run; it qualifies no GPU or real browser device.

All of these current sources and fixtures are UNRUN. No module execution, checks,
install, build, packing, index/ref/history operations or remote actions ran during
the source-only lease. Exact current artifacts and primary checks remain pending.
Rollback restores only changed intake paths from the before directory and removes
the two new controller source/document files while retaining all evidence.

The latest coordinator decision at 2026-10-09T19:38:06Z replaces the old uppercase
contribution rule with sentence case. This owner's AGENTS and the later Commit
attribution section of CONTRIBUTING use the current sentence and required
advertising rationale; README contains policy links without the rejection line.
Conduct, Security, LICENSE and source lineage remain unchanged. The frozen
CI `9e046dd482e0229dc7c7b2d71b079d5905664656` policy still contains the prior
uppercase rule. Its receipts retain that exact original scope. A newly checked
common policy/caller pin and replacement per-owner conformance are pending;
the source receipt is neither a new CI qualification nor remote admission.

You cannot have AI as a co-author, or your contributions will be rejected.
