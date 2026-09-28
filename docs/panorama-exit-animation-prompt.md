# Work prompt: pull out of a panorama when leaving it

Execute this task when the user starts a fresh conversation with this file.
Work in `/Users/felg/gh/foss-earth`. Read the current `AGENTS.md`,
[docs/proposals/settings.md](proposals/settings.md) and
[docs/validation/panorama-visual-contract.md](validation/panorama-visual-contract.md) first.
If [panorama-mode-prompt.md](panorama-mode-prompt.md) hasn't been done yet, do that first: it
changes how a panorama is left.

The user's words:

> when exiting a 360 image i want to have a animation zooming out of it, like pulling out from
> the direction it is currently facing, again this should be a setting, on by default

## How entering and leaving work today

Both are in `enter` and `exitTo`, in [src/scenes/loadScene.ts](../src/scenes/loadScene.ts).

- **Entering** grows a virtual sphere about the orb until it covers the view and its rays equal
  the view's. It then hands off to the full-screen image, which looks exactly like the orb's
  last frame (`scene.panorama.expandDuration`). When that isn't possible (behind, inside, off
  screen, or reduced motion), it fades instead.
- **Leaving** restores the map view saved when the panorama was entered, then fades the image
  off it (`scene.panorama.fadeDuration`, or `reducedFadeDuration`).

## What to build

- **Leaving runs the entry in reverse.** Hand off from the full-screen image to the expanded
  sphere, then shrink it back into the orb while the camera backs away from the direction the
  viewer is facing.
- **Where the map view ends is a decision to make.** Today it returns to the saved view. The
  user's words suggest ending where the viewer faced: the same heading, looking at the orb.
  Recommend one, say why, and ask the user if it isn't clear.
- **It is a setting, on by default:** a named parameter with a unit and bounds, such as the
  animation's duration in milliseconds, with 0 meaning off. Its home is beside
  `scene.panorama.expandDuration` ("Entry reveal", 350 ms).
- **Reduced motion** keeps the fade.
- **Input:** looking, Esc, Back and following a link during the animation must behave as they
  do during entry.

## Checks and report

- **Checks:** after each edit, `npx tsc -b`, `npx vitest related --run <changed files>` and
  `npm run lint`. Then run `npm run ci` once at the end.
- **The visual contract:** add the exit's handoff condition to its checks, as it has for entry.
- **Servers:** don't start one. Tell the user to try it with `npm run dev` in the tour
  repository (`/Users/felg/gh/UMN-VR/UMN-VR.github.io`).
- **Commit:** commit to `main` and push.
