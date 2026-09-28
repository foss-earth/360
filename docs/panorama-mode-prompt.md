# Work prompt: a panorama opens as a tab, at full detail

Execute this task when the user starts a fresh conversation with this file.
Work in `/Users/felg/gh/foss-earth`, then in the tour at `/Users/felg/gh/UMN-VR/UMN-VR.github.io`
for its one part. Read the current `AGENTS.md` of both first, then:

- [docs/ui-layout.md](ui-layout.md);
- [docs/proposals/settings.md](proposals/settings.md);
- [docs/scenes/format.md](scenes/format.md);
- [docs/proposals/panorama-scenes.md](proposals/panorama-scenes.md);
- [docs/validation/panorama-visual-contract.md](validation/panorama-visual-contract.md).

This blocks the UMN campus tour. The tour is FOSS Earth's second consumer: 60 of YouVisit's
360° photographs in one scene. The user tested it with `npm run dev` in the tour repository,
liked the map side, and won't move on until this is done.

## What the user asked for

> ALL of the 360 images are very low res, we should have a dropdown to select the quality,
> which brings the question, where should the dropdown be, we do not have a place to put UI
> for a 360 image, so I think we should use a tab, make it so what when i click into a 360
> image it opens a tab titled '360: (image name)' and the 360 image viewer clicks when closed,
> and we show the info for that 360 image on that tab, with a detail slider, default to max,
> and the 'x' on the bottom right feels weird, seeing a tab pop up when i click on the image,
> and closing the tabe to close the image (or ESC) feels way more natural than that 'x' left
> of the attribution

("clicks when closed" means the viewer closes when the tab is closed.)

> the tabs that we show when on 360 image viewer mode should probably not be the same as when
> in map mode, for example the map tab should no be there

> the 'scenes' tab contains a lot of stuff that should be in other places, maybe we should
> have a '360 image settings' tab with this stuff in it (shown only in 360 image mode)

> the dropdown for foss earth gets hidden behind the map/360 image viewer, it should be in
> front [...] it only becomes an issue when i have many tabs and the dropdown gets pushed out
> of the UI tabs window

This work adds tabs, so it will trigger that last bug more often. Fix it here.

## What to build

### 1. The panorama's tab

- **Opening:** entering a panorama opens a tab titled "360: <title>".
- **Following a link:** going to another panorama retitles the same tab rather than opening a
  second one.
- **Closing:** closing the tab leaves the panorama, exactly as Esc does.
- **Remove the × left of the attribution.** It is the `close` button in `createSceneHud`
  ([src/shell/scenesPanel.ts](../src/shell/scenesPanel.ts), around line 319). The tab and Esc
  are the ways out.

### 2. What the tab shows

- **The photograph's details:**
  - its title and description, and the group it belongs to;
  - where it was taken, with the accuracy the scene gives;
  - its pose, and whether its north is set (`aligned`);
  - its attribution, licence and credit;
  - its links.
- **Which image is on screen, and why nothing larger is.** The loader already computes this as
  `state.detail` in `refine()` ([src/scenes/loadScene.ts](../src/scenes/loadScene.ts)): the
  representation, plus the limitation that stopped a larger one.
- **Move the current-panorama details** that the Scenes tab now shows onto this tab.

### 3. The detail slider, defaulting to the most detailed image

**Today the choice is automatic.**

- `refine()` asks for `immersionFaceTexels(viewport height × device pixel ratio, vertical field
  of view, scene.panorama.immersionDensity)`.
- `chooseRepresentation` ([src/scenes/budget.ts](../src/scenes/budget.ts)) then takes the
  smallest immersion image that meets it, within `scene.panorama.immersionMaxSide` and the
  memory budgets.

**The user wants the most detailed image by default and a slider to lower it.**

- Make the slider a named parameter under the settings rules: a real unit, bounds, a default
  with its reason, and a continuous control.
- Its one home is this tab, as the user asked. Don't give it a second copy in the settings tab
  below.
- The tab already shows where the value is and why, per section 2.

### 4. Why the tour's images look soft today

Fixing the control alone won't make them sharp.

**The tour doesn't publish the full image.**

- YouVisit's originals are 6144 × 3072.
- The tour's build prepares only 2048 and 4096 wide (`--immersion-widths 2048,4096` in
  `tools/twin-cities/build-scene.mjs`).
- 4096 wide is 1024 texels per cube face, and 6144 wide is 1536.

**Even the 4096 image falls short of the default target:**

| Viewport | Field of view | Sharpness target | Texels per face wanted |
| --- | --- | --- | ---: |
| 900 CSS px tall at a device pixel ratio of 2 | 100° vertical, YouVisit's default | 1 texel per pixel | 1800 / tan 50° ≈ 1510 |

When the viewer zooms in, the target rises further.

**FOSS Earth's default budgets would refuse a 6144 image.**

- It needs 72 MiB decoded (6144 × 3072 × 4 B), and about 96 MiB on the GPU with its mipmaps.
- `scene.panorama.decodedMiB` is 64 and `overlapMiB` is 48.
- `sourceGpuMiB` is 128, which cannot hold the 4096 image on screen (43 MiB) while a 6144 comes
  in.
- These defaults are marked provisional in `src/settings/catalogue/scenes.ts`. Change them so
  the default loads the largest image a scene offers, within the device's texture limit, and
  give each new default its reason.

**The tour's part.** The tour repository owns its images. Make `2048,4096,6144` the build's
default in `tools/twin-cities/build-scene.mjs` and its README, run `npm run build:scene`, then
`npm run ci`.

- It adds about 250 MB to the repository and to every deploy, which publishes `dist/` to
  `gh-pages`.
- Report the new total before committing.

### 5. Different tabs in a panorama

In a panorama, the tabs about the map don't apply, such as Map and map detail.

- **Which tabs to show:** the panorama's tab, the 360 settings tab below, and those that still
  apply.
- **Deciding:** find how tabs are registered (`src/windowing/`, `src/shell/`) and how the app
  knows it is in a panorama (the scene controller's state). Decide tab by tab.
- **The report:** list your decisions.

### 6. A "360 image settings" tab, shown only in a panorama

The Scenes tab's sections are content, appearance, loading, navigation and credits
(`scenesPanel.ts`, around line 210). Their parameters come from
`src/settings/catalogue/scenes.ts`.

- **What moves:** parameters that only matter inside a panorama, such as sharpness, the field
  of view, looking and levelling.
- **What stays in Scenes:** choosing a scene, and what the globe shows, such as orbs and
  markers.
- **Loading budgets** serve both: previews load for the orbs on the map. Decide where they go
  and say why.
- **Rules:** one home per setting, and a toolbar button toggles a tab.

### 7. The dropdown behind the viewer

- **Which dropdown:** find the one the user means. It is probably the one on FOSS Earth's tab
  strip that holds tabs pushed out of the window.
- **Why it hides:** find out why it draws behind the globe canvas and the panorama viewer once
  it leaves the tab window.
- **Fix it** so it is always in front.

## Not in this task

- **The exit animation:** [panorama-exit-animation-prompt.md](panorama-exit-animation-prompt.md).
- **The camera pivot bug:** [camera-pivot-and-zoom-prompt.md](camera-pivot-and-zoom-prompt.md).
- **Tile loading:** [tile-loading-prompt.md](tile-loading-prompt.md).

## Checks and report

- **Checks:** after each edit, `npx tsc -b`, `npx vitest related --run <changed files>` and
  `npm run lint`. At the end, run `npm run ci` once, here and in the tour.
- **0SFS** imports the Scenes tab and its parameters through the `foss-earth/shell` and
  `foss-earth/settings` barrels, so run `npx tsc -b` and `npm run lint` in `../0sfs` too.
- **Docs:** update [docs/ui-layout.md](ui-layout.md) and the scene docs where the rules or the
  behaviour changed.
- **Servers:** don't start one. Tell the user to run `npm run dev` in the tour repository and
  what to try.
- **Commits:** commit FOSS Earth to `main` and push. Commit the tour to `main` and don't push
  it; the user deploys the tour.
