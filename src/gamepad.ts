/** Sphere-owned controller records. The host supplies the common controller
 * transform and named stick deadzone; importing this entry initializes no driver. */
import type { ActionDescriptor, BindingSource, BindingSpec, BindingTransformSpec } from "@felipegalind0/gamepad-tools/core";

/** Looking around a sphere: bound in the "panorama" context, which a scene's lease selects. */
export const SPHERE_GAMEPAD_ACTIONS: readonly ActionDescriptor[] = [
  { id: "panorama.lookX", label: "Look left / right", category: "Panorama", kind: "rate", range: [-1, 1], contexts: ["panorama"], available: true },
  { id: "panorama.lookY", label: "Look down / up", category: "Panorama", kind: "rate", range: [-1, 1], contexts: ["panorama"], available: true },
  { id: "panorama.zoom", label: "Zoom in / out", category: "Panorama", kind: "rate", range: [-1, 1], contexts: ["panorama"], available: true },
  { id: "panorama.exit", label: "Exit the panorama", category: "Panorama", kind: "command", contexts: ["panorama"], available: true },
];

export interface SphereProfileContribution {
  readonly contexts: readonly string[];
  bindings(slot: number, deadzone: number): readonly BindingSpec[];
}

function axisSource(slot: number, axisIndex: number): BindingSource {
  return { selector: { kind: "gamepad-axis", gamepadSlot: slot, axisIndex } };
}

function buttonSource(slot: number, buttonIndex: number): BindingSource {
  return { selector: { kind: "gamepad-button", gamepadSlot: slot, buttonIndex } };
}

/** Supply gamepad-tools' public DEFAULT_BINDING_TRANSFORM from the host. The
 * Engine profile calls bindings with its chosen slot and existing named deadzone. */
export function createSphereProfileContribution(transform: Readonly<BindingTransformSpec>): SphereProfileContribution {
  const stickRate = (id: string, actionId: string, source: BindingSource, deadzone: number, invert = false): BindingSpec => ({
    id,
    actionId,
    kind: "single",
    semantics: "rate",
    contexts: ["panorama"],
    enabled: true,
    precedence: 0,
    transform: { ...transform, deadzone, invert },
    source,
  });
  return {
    contexts: ["panorama"],
    bindings: (slot, deadzone) => [
      // In a sphere the right stick looks the way it points, and the
      // triggers zoom as they do on the globe.
      stickRate("standard-panorama-look-x", "panorama.lookX", axisSource(slot, 2), deadzone),
      stickRate("standard-panorama-look-y", "panorama.lookY", axisSource(slot, 3), deadzone, true),
      {
        id: "standard-panorama-zoom",
        actionId: "panorama.zoom",
        kind: "paired",
        semantics: "rate",
        contexts: ["panorama"],
        enabled: true,
        precedence: 0,
        transform: { ...transform, inputRange: [0, 1], outputRange: [-1, 1] },
        positiveSource: buttonSource(slot, 7),
        negativeSource: buttonSource(slot, 6),
      },
      {
        id: "standard-panorama-exit",
        actionId: "panorama.exit",
        kind: "single",
        semantics: "command",
        contexts: ["panorama"],
        enabled: true,
        precedence: 0,
        transform: { ...transform, inputRange: [0, 1], outputRange: [0, 1] },
        // The right face button: B on an Xbox layout.
        source: buttonSource(slot, 1),
      },
    ],
  };
}
