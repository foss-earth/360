# Panorama gestures and visible anchors

The full panorama and interactive scene previews use the same look model.
Measured pointer gestures move the image one CSS pixel per input pixel at any
zoom. Applying a fixed number of degrees per pixel makes a zoomed-in image move
much faster than the finger; use the sphere camera geometry instead.

## Settings

These controls live in **360 image settings → Looking** unless noted otherwise.

| Setting | Behavior |
| --- | --- |
| `scene.panorama.verticalFovRange` | Default vertical FOV range 20–140°. Allowed setting bounds 10–150°. |
| `scene.panorama.entryFov` | Default 100°, bounded to 10–150° and the selected zoom range; under Entering. |
| `scene.panorama.showAnchors` | Show anchors, off by default; independent of the map's `input.showNavigationAnchors`. |
| `scene.panorama.dragSensitivity` | Legacy degrees-per-pixel fallback when there is no measured viewport. |
| `scene.panorama.swipeSensitivity` | The corresponding trackpad fallback when there is no measured viewport. |

## Hold an image point through the gesture

`createLookModel` in `src/look.ts` casts a common-space ray through the initial
surface-local point. `anchorSphereCamera` solves a legal heading and pitch that
keep that ray at the gesture's desired destination. Pure pans preserve FOV.
Coordinates and viewport dimensions must use the same measured CSS rectangle,
including its offset from the whole canvas. Backing-store resolution and device
pixel ratio do not change these input units.

A one-finger or mouse drag retains its ray across consecutive moves. Two-touch
pan and pinch retain the ray through the initial midpoint while combining
midpoint motion and separation changes in one camera update.

A trackpad swipe captures the sphere point under the cursor at the start of
the pan. Later wheel events accumulate scroll displacement from that point;
cursor motion does not pick another point. `attachLookInput` passes
`swipe(dx, dy, at, continuing)` with `continuing` true while successive pan
events are less than 180 ms apart, including operating-system momentum.
It uses the binding Window's monotonic `performance.now()`. An idle gap of
180 ms or more, another gesture, contact input, blur or cancellation starts
a fresh pan. This works even when the optional anchor display is absent.

The solver stops at the last feasible pose near a pitch limit without rolling
the camera or jumping to the other mathematical branch. Keep the original ray
when the desired destination becomes unreachable. Its actual projection is
the next solve's source, so reversing the gesture can bring the same point
back. Recasting at the cursor on every event loses this behavior.

While a drag is held, frame ticks do not apply its recorded velocity. On
release, glide uses the camera's actual angular displacement, with heading
wrapped across 0/360°. A stationary release, reduced motion or zero glide
half-life stops immediately. Trackpad momentum belongs to the operating system;
the look model adds no second swipe glide.

## Draw the actual point

`LookModel.anchor()` projects the retained ray into surface-local CSS pixels.
`subscribeAnchors()` reports camera changes and gesture transitions, including
glide completion. A marker can lag behind the finger at a pitch limit because
it shows the image point, rather than the pointer position.

The optional `anchorMarkers` input port creates its renderer lazily. The host
setting subscription applies toggles immediately. `createImageAnchorMarkers`
from `./globe-browser` reuses Engine's map grab arrows and zoom reticle, converts
the local projection to client coordinates, and clips outside the measured
surface. A released grab uses the map's gray glide color. Wheel and Safari
markers disappear 180 ms after the last event. Dropping from two touches to
one hides the old midpoint until the remaining finger moves; blur, cancellation
and detach clear the display, timers and subscriptions.

Earth App wires the setting to both its immersive viewer and Scenes previews.
Preview renderers use the iframe canvas's own document and CSS dimensions.
See [globe adapters](globe-bindings.md) for the host ports.

## Regression coverage

- `tests/sphereInput.test.ts`: projection accuracy from 10° to 150° FOV, retained
  rays, pitch-limit reversal, heading wrap and release velocity.
- `tests/imageCameraAnchors.test.ts`: projected marker geometry, gesture flags,
  glide, subscriptions and missing-camera/viewport behavior.
- `tests/imageAnchorMarkers.test.ts`: live toggles, cursor movement during a
  trackpad stream, momentum, idle boundaries, absent/disabled markers, touch
  transitions and cleanup.
- `tests/globeBindings.test.ts`: map styling, measured offsets and iframe realms.
- Earth App's `src/app/sceneWorld.test.ts`: the real settings registry and viewer
  adapter together, including default-off and live enable/disable behavior.

Run linked-library checks with the `source` export condition, as Earth App's
development setup does. An isolated package typecheck can read stale sibling
`dist` declarations; Earth App's `npm run typecheck` checks the linked source
interfaces. The [development setup](../README.md#development) describes the
side-by-side library arrangement.
