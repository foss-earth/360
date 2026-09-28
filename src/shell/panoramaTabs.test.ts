// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { FOSS_EARTH_PARAMETERS, FOSS_EARTH_SECTION_TITLES } from "../settings/catalogue";
import { createSettingsRegistry } from "../settings/registry";
import type { SceneEntryStatus, SceneStatus } from "../scenes/loadScene";
import type { SceneController, SceneControllerState } from "../scenes/sceneController";
import { createPanoramaTabs } from "./panoramaTabs";

afterEach(() => document.body.replaceChildren());

const MALL: SceneEntryStatus = {
  id: "northrop-mall", title: "Northrop Mall", description: "The heart of campus.", supported: true, message: null,
  placement: "placed", preview: "ready", previewDetail: null,
  marker: { mode: "ground-relative", eastM: 0, northM: 0, offsetM: 25, radiusMeters: 3, authoredRadius: true },
  capture: { longitudeDeg: -93.2353, latitudeDeg: 44.9765, heightMeters: null, horizontalAccuracyMeters: 50 },
  pose: { headingDeg: 12, pitchDeg: 0, rollDeg: 0, aligned: false },
  attribution: { text: "© Regents of the University of Minnesota", license: "All rights reserved", url: "https://umn.edu/" },
  images: [
    { id: "preview-256", role: "preview", projection: "cube", width: 256, height: 256, aroundPx: 1024, encodedBytes: 1, gpuBytes: 1 },
    { id: "whole-2048", role: "immersion", projection: "equirectangular", width: 2048, height: 1024, aroundPx: 2048, encodedBytes: 1, gpuBytes: 1 },
    { id: "whole-6144", role: "immersion", projection: "equirectangular", width: 6144, height: 3072, aroundPx: 6144, encodedBytes: 1, gpuBytes: 1 },
  ],
  links: [{ id: "next-stop", label: "Next stop: Walter Library", target: "walter", enabled: true, placed: false }],
};
const WALTER: SceneEntryStatus = { ...MALL, id: "walter", title: "Walter Library", links: [] };

function status(phase: SceneStatus["phase"], active: string | null, target: string | null, immersionDetail: SceneStatus["immersionDetail"] = null): SceneStatus {
  return {
    phase, active, target, immersionDetail, entries: [MALL, WALTER],
    groups: [{ id: "mall", title: "1. Northrop Mall", members: ["northrop-mall"] }, { id: "library", title: "2. Walter Library", members: ["walter"] }],
  } as unknown as SceneStatus;
}

function mount() {
  const settings = createSettingsRegistry({ storage: null });
  settings.register(FOSS_EARTH_PARAMETERS);
  for (const [tab, section, title] of FOSS_EARTH_SECTION_TITLES) settings.setSectionTitle(tab, section, title);
  let listener: (state: SceneControllerState) => void = () => {};
  const exit = vi.fn(async () => ({ ok: true as const }));
  const follow = vi.fn(async () => ({ ok: true as const }));
  const controller = {
    subscribe(next: (state: SceneControllerState) => void) { listener = next; next({ loading: null, errors: [], status: null }); return () => {}; },
    handle: () => ({ exit, follow }),
  } as unknown as SceneController;
  const openSettings = vi.fn();
  const tabs = createPanoramaTabs({ settings, controller, openSettings });
  document.body.append(tabs.panorama, tabs.settings);
  const show = (next: SceneStatus) => listener({ loading: null, errors: [], status: next });
  const text = () => tabs.panorama.textContent ?? "";
  return { tabs, show, text, exit, follow, openSettings };
}

describe("a panorama's tabs", () => {
  it("are titled by the panorama being entered or on screen, and exist only then", () => {
    const { tabs, show } = mount();
    const heard = vi.fn();
    tabs.subscribe(heard);
    expect(tabs.getSnapshot()).toEqual({ title: null });
    show(status("preparing", null, "northrop-mall"));
    const entering = tabs.getSnapshot();
    expect(entering).toEqual({ title: "360: Northrop Mall" });
    show(status("immersive", "northrop-mall", null));
    // Unchanged: the same object, and nobody is told.
    expect(tabs.getSnapshot()).toBe(entering);
    expect(heard).toHaveBeenCalledTimes(1);
    // Following a link keeps the title until the destination is on screen.
    show(status("preparing", "northrop-mall", "walter"));
    expect(tabs.getSnapshot().title).toBe("360: Northrop Mall");
    show(status("immersive", "walter", null));
    expect(tabs.getSnapshot().title).toBe("360: Walter Library");
    show(status("exiting", "walter", null));
    expect(tabs.getSnapshot()).toEqual({ title: null });
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it("show the photograph's details, its links, which image is on screen and why nothing larger is", () => {
    const { tabs, show, text, follow, openSettings, exit } = mount();
    show(status("entering", null, "northrop-mall"));
    const links = () => Array.from(tabs.panorama.querySelectorAll<HTMLButtonElement>(".foss-earth-scene-button")).filter(button => button.textContent!.startsWith("Next stop"));
    expect(links()[0].disabled).toBe(true);
    expect(text()).toContain("Entering: the preview shows first");

    show(status("immersive", "northrop-mall", null, { representation: "whole-2048", limitation: "The 6144 px image is more than the 4096 px image detail allows.", loading: null }));
    expect(text()).toContain("Northrop Mall");
    expect(text()).toContain("The heart of campus.");
    expect(text()).toContain("In 1. Northrop Mall.");
    expect(text()).toContain("Taken at 44.976500°, -93.235300°, to within 50 m. Its height is not known.");
    expect(text()).toContain("Pose: heading 12.0°, pitch 0.0°, roll 0.0°. North is not set: the image faces an arbitrary direction");
    expect(text()).toContain("© Regents of the University of Minnesota · All rights reserved · source");
    expect(tabs.panorama.querySelector<HTMLAnchorElement>('a[href="https://umn.edu/"]')!.rel).toBe("noopener noreferrer");
    expect(text()).toContain("Showing the 2048 × 1024 px image.");
    expect(text()).toContain("The 6144 px image is more than the 4096 px image detail allows.");
    expect(text()).toContain("This panorama offers preview cubes of 256 px and images 2048 and 6144 px wide.");
    links()[0].click();
    expect(follow).toHaveBeenCalledWith("next-stop");

    show(status("immersive", "northrop-mall", null, { representation: "whole-2048", limitation: null, loading: "whole-6144" }));
    expect(text()).toContain("Loading the 6144 × 3072 px image…");
    show(status("immersive", "northrop-mall", null, { representation: "whole-6144", limitation: null, loading: null }));
    expect(text()).toContain("It is the largest image this panorama offers.");

    Array.from(tabs.panorama.querySelectorAll("button")).find(button => button.textContent === "360 image settings")!.click();
    expect(openSettings).toHaveBeenCalledOnce();
    tabs.leave();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("hold the image detail, and 360 image settings what matters only inside", () => {
    const { tabs } = mount();
    expect(tabs.panorama.querySelector('[data-parameter="scene.panorama.immersionWidth"]')).not.toBeNull();
    for (const id of ["immersionDensity", "verticalFovRange", "dragSensitivity", "lookRate", "entryOrientation", "orientDuration"]) {
      expect(tabs.settings.querySelector(`[data-parameter="scene.panorama.${id}"]`), id).not.toBeNull();
    }
    expect(tabs.settings.querySelector('[data-parameter="scene.panorama.immersionWidth"]')).toBeNull();
    expect(tabs.settings.querySelector('[data-parameter="scene.panorama.markerDiameter"]')).toBeNull();
  });
});
