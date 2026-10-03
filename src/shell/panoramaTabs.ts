/**
 * The two tabs a panorama brings (docs/ui-layout.md): its own, titled
 * "360: <title>", with the photograph's details, its links and its image
 * detail; and 360 image settings, with what matters only inside a panorama.
 * Both exist only while a panorama is entered or being entered. Closing the
 * panorama's tab leaves it, as Escape does. The window overlay reads the
 * title from `getSnapshot` to know which tabs to show, and whether a panorama
 * is on screen yet to know when to show the panorama's tab.
 */
import { PANORAMA_SETTINGS_TAB, PANORAMA_TAB } from "../settings/catalogue/scenes";
import type { SettingsRegistry } from "../settings/registry";
import type { SceneEntryStatus, SceneImageStatus, SceneStatus } from "../scenes/loadScene";
import type { SceneController } from "../scenes/sceneController";
import { createExternalLinkIcon } from "./externalLinkIcon";
import { createParameterSection, createSectionsElement, type ParameterSectionHandle, type SectionsElementHandle } from "./settings/parameterSection";

export interface PanoramaTabsSnapshot {
  /** The panorama's tab title, "360: <title>", while one is entered or being entered; null outside one. */
  title: string | null;
  /**
   * Whether a panorama is on screen: false while the first is still being
   * entered from the globe, the camera flying in; true from then on, following
   * a link included.
   */
  onScreen: boolean;
}

export interface PanoramaTabs {
  /** The panorama's own tab. */
  panorama: HTMLElement;
  /** The 360 image settings tab. */
  settings: HTMLElement;
  /** The same object until the title changes. */
  getSnapshot(): PanoramaTabsSnapshot;
  subscribe(listener: () => void): () => void;
  /** Leaves the panorama, or cancels entering one, as Escape does: what closing its tab does. */
  leave(): void;
  destroy(): void;
}

export interface PanoramaTabsOptions {
  settings: SettingsRegistry;
  controller: SceneController;
  /** Opens the 360 image settings tab, for the panorama tab's button to it. */
  openSettings?: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const note = (text: string): HTMLParagraphElement => el("p", "foss-earth-choices__note", text);

function button(label: string, onClick: () => void, title?: string): HTMLButtonElement {
  const element = el("button", "foss-earth-choice foss-earth-scene-button", label);
  element.type = "button";
  if (title) element.title = title;
  element.addEventListener("click", onClick);
  return element;
}

/** "a", "a and b", "a, b and c". */
function listed(items: readonly (string | number)[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The panorama a tab is about: the one on screen, or the one being entered. Null outside a panorama. */
export function panoramaOf(status: SceneStatus | null): SceneEntryStatus | null {
  if (!status || (status.phase !== "preparing" && status.phase !== "entering" && status.phase !== "immersive")) return null;
  const id = status.active ?? status.target;
  return status.entries.find(entry => entry.id === id) ?? null;
}

function takenAt(entry: SceneEntryStatus): string {
  const { latitudeDeg, longitudeDeg, heightMeters, horizontalAccuracyMeters } = entry.capture;
  const accuracy = horizontalAccuracyMeters === null ? ", with no accuracy given" : `, to within ${horizontalAccuracyMeters} m`;
  const height = heightMeters === null ? "Its height is not known." : `${heightMeters.toFixed(1)} m above the WGS84 ellipsoid.`;
  return `Taken at ${latitudeDeg.toFixed(6)}°, ${longitudeDeg.toFixed(6)}°${accuracy}. ${height}`;
}

function poseText(entry: SceneEntryStatus): string {
  const { headingDeg, pitchDeg, rollDeg, aligned } = entry.pose;
  const north = aligned === true
    ? "North is set: the heading was measured against true north."
    : aligned === false
      ? "North is not set: the image faces an arbitrary direction, so bearings in it are not compass bearings."
      : "The scene does not say whether its north is set.";
  return `Pose: heading ${headingDeg.toFixed(1)}°, pitch ${pitchDeg.toFixed(1)}°, roll ${rollDeg.toFixed(1)}°. ${north}`;
}

/** "equi-angular cube tiles", "cube tiles". */
function tilesText(image: SceneImageStatus): string {
  return image.warp === "equi-angular" ? "equi-angular cube tiles" : "cube tiles";
}

/** "the 6144 × 3072 px image", "the 256 px preview cube", "equi-angular cube tiles of 1536 px faces". */
function imageText(image: SceneImageStatus): string {
  if (image.projection === "tiled-cube") return `${tilesText(image)} of ${image.width} px faces, ${image.aroundPx} px around`;
  return image.projection === "cube"
    ? `the ${image.width} px ${image.role === "preview" ? "preview " : ""}cube, ${image.aroundPx} px around`
    : `the ${image.width} × ${image.height} px image`;
}

const kibibytes = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`);

/** How far a tiled cube on screen has got with the view: "38 of 40 tiles in view, level 3 of 3; 412 KiB downloaded." */
function tilesProgress(tiles: NonNullable<NonNullable<SceneStatus["immersionDetail"]>["tiles"]>): string {
  const state = tiles.complete ? "every tile the view needs is on screen" : `${tiles.shownInView} of ${tiles.inView} tiles in view on screen${tiles.loading ? `, ${tiles.loading} loading` : ""}`;
  return `${state.charAt(0).toUpperCase()}${state.slice(1)}, at level ${tiles.levelWanted} of ${tiles.finestLevel}; ${tiles.resident} of ${tiles.slots} tiles held, ${kibibytes(tiles.receivedBytes)} downloaded${tiles.reusedTiles ? `, ${tiles.reusedTiles} ${tiles.reusedTiles === 1 ? "tile" : "tiles"} from saved images` : ""}.`;
}

function offeredText(images: readonly SceneImageStatus[]): string {
  const parts: string[] = [];
  const previews = images.filter(image => image.role === "preview").map(image => image.width);
  if (previews.length) parts.push(`preview cubes of ${listed(previews)} px`);
  const whole = images.filter(image => image.role === "immersion");
  const flat = whole.filter(image => image.projection === "equirectangular").map(image => image.width);
  if (flat.length) parts.push(`${flat.length === 1 ? "an image" : "images"} ${listed(flat)} px wide`);
  const cubes = whole.filter(image => image.projection === "cube").map(image => image.width);
  if (cubes.length) parts.push(`cubes of ${listed(cubes)} px faces`);
  for (const tiled of whole.filter(image => image.projection === "tiled-cube")) parts.push(`${tilesText(tiled)}, ${tiled.tiles ?? 0} of them up to ${tiled.width} px faces`);
  return `This panorama offers ${listed(parts)}.`;
}

export function createPanoramaTabs(options: PanoramaTabsOptions): PanoramaTabs {
  const { settings, controller } = options;
  const handles: ParameterSectionHandle[] = [];
  const section = (tab: string, id: string, main?: HTMLElement, showAll = true): HTMLElement => {
    const handle = createParameterSection(settings, { tab, section: id, showAll, ...(main ? { main } : {}) });
    handles.push(handle);
    return handle.element;
  };

  // ─── The panorama's tab ────────────────────────────────────────────
  const photograph = el("div", "foss-earth-choices foss-earth-panorama-photograph");
  const links = el("div", "foss-earth-choices");
  const detail = el("div", "foss-earth-choices");
  const panorama: SectionsElementHandle = createSectionsElement([
    { id: "panorama.photograph", title: settings.getSectionTitle(PANORAMA_TAB, "photograph"), element: section(PANORAMA_TAB, "photograph", photograph, false), defaultOpen: true },
    { id: "panorama.links", title: settings.getSectionTitle(PANORAMA_TAB, "links"), element: section(PANORAMA_TAB, "links", links, false), defaultOpen: true },
    { id: "panorama.detail", title: settings.getSectionTitle(PANORAMA_TAB, "detail"), element: section(PANORAMA_TAB, "detail", detail), defaultOpen: true },
  ]);
  panorama.element.classList.add("foss-earth-panorama-tab");

  // ─── 360 image settings ────────────────────────────────────────────
  const panoramaSettings = createSectionsElement([
    { id: "panorama-settings.image", title: settings.getSectionTitle(PANORAMA_SETTINGS_TAB, "image"), element: section(PANORAMA_SETTINGS_TAB, "image"), defaultOpen: true },
    { id: "panorama-settings.looking", title: settings.getSectionTitle(PANORAMA_SETTINGS_TAB, "looking"), element: section(PANORAMA_SETTINGS_TAB, "looking"), defaultOpen: false },
    { id: "panorama-settings.entering", title: settings.getSectionTitle(PANORAMA_SETTINGS_TAB, "entering"), element: section(PANORAMA_SETTINGS_TAB, "entering"), defaultOpen: false },
  ]);

  const follow = (id: string): void => { void controller.handle()?.follow(id); };

  function render(status: SceneStatus, entry: SceneEntryStatus): void {
    const inside = status.phase === "immersive" && status.active === entry.id;
    photograph.replaceChildren();
    photograph.append(el("div", "foss-earth-choices__heading", entry.title));
    if (entry.description) photograph.append(note(entry.description));
    const groups = status.groups.filter(group => group.members.includes(entry.id)).map(group => group.title);
    if (groups.length) photograph.append(note(`In ${listed(groups)}.`));
    photograph.append(note(takenAt(entry)), note(poseText(entry)));
    if (entry.attribution) {
      const credit = note(entry.attribution.text);
      if (entry.attribution.license) credit.append(` · ${entry.attribution.license}`);
      if (entry.attribution.url) {
        const link = el("a", "foss-earth-scene-credit-link", "source");
        link.href = entry.attribution.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.append(createExternalLinkIcon());
        credit.append(" · ", link);
      }
      photograph.append(credit);
    }
    photograph.append(note(inside ? "Close this tab, or press Escape, to go back to the map." : "Entering. Close this tab, or press Escape, to stay on the map."));

    links.replaceChildren();
    if (entry.links.length === 0) links.append(note("No links lead from this panorama."));
    for (const link of entry.links) {
      const go = button(link.label, () => follow(link.id), link.enabled ? `Go to ${link.label}` : "It leads to something this viewer does not show.");
      go.disabled = !inside || !link.enabled;
      links.append(go);
    }

    detail.replaceChildren();
    const shown = status.immersionDetail && inside ? entry.images.find(image => image.id === status.immersionDetail!.representation) ?? null : null;
    if (!shown || !status.immersionDetail) {
      detail.append(note("Entering: the preview shows first, then the largest image the detail allows."));
    } else {
      detail.append(note(`Showing ${imageText(shown)}.`));
      if (status.immersionDetail.tiles) detail.append(note(tilesProgress(status.immersionDetail.tiles)));
      const loading = status.immersionDetail.loading ? entry.images.find(image => image.id === status.immersionDetail!.loading) ?? null : null;
      if (loading) detail.append(note(`Loading ${imageText(loading)}…`));
      else detail.append(note(status.immersionDetail.limitation ?? "It is the largest image this panorama offers."));
    }
    detail.append(note(offeredText(entry.images)));
    if (options.openSettings) {
      const more = el("div", "foss-earth-choices");
      more.append(note("Representation, sharpness, looking and levelling:"), button("360 image settings", options.openSettings, "Opens the 360 image settings tab."));
      detail.append(more);
    }
  }

  // ─── State ─────────────────────────────────────────────────────────
  let snapshot: PanoramaTabsSnapshot = { title: null, onScreen: false };
  const listeners = new Set<() => void>();
  let rendered = "";
  const off = controller.subscribe(state => {
    const entry = panoramaOf(state.status);
    const title = entry ? `360: ${entry.title}` : null;
    const onScreen = entry !== null && state.status !== null && state.status.active !== null;
    if (title !== snapshot.title || onScreen !== snapshot.onScreen) {
      snapshot = { title, onScreen };
      for (const listener of [...listeners]) listener();
    }
    if (!entry || !state.status) return;
    const status = state.status;
    // The view changes every frame while looking; redraw only when something shown here does.
    const key = JSON.stringify([status.phase, status.active, entry, status.immersionDetail, status.groups]);
    if (key === rendered) return;
    rendered = key;
    render(status, entry);
  });

  return {
    panorama: panorama.element,
    settings: panoramaSettings.element,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    leave() {
      void controller.handle()?.exit();
    },
    destroy() {
      off();
      listeners.clear();
      for (const handle of handles) handle.destroy();
      panorama.destroy();
      panoramaSettings.destroy();
    },
  };
}
