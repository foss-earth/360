// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createViewerTabs } from "../src/panels.js";
import type { ViewerStatus } from "../src/index.js";
import { image } from "./fixtures/viewer.js";
describe("host-composed image tabs",()=>{
  it("shows injected identity/credits/actions and tears down every host section",()=>{
    let state:ViewerStatus={phase:"overview",active:null,target:null};let listener:(s:ViewerStatus)=>void=()=>{};
    const off=vi.fn(),destroy=vi.fn(),exit=vi.fn(),activateAction=vi.fn(async()=>true),input=image();input.credits.url="javascript:alert(1)";input.actions=[{id:"next",label:"Next view",activate:()=>true}];
    const tabs=createViewerTabs({document,viewer:{status:()=>state,subscribe(fn){listener=fn;fn(state);return off;},exit,activateAction},image:()=>input,sectionTitle:(_tab,section)=>section,parameterSection({main}){const element=document.createElement("div");if(main)element.append(main);return{element,destroy};},sections(entries){const element=document.createElement("div");element.append(...entries.map(entry=>entry.element));return{element,destroy};},representationText:r=>r.id,detail:()=>({shown:"the test image"})});
    state={phase:"immersive",active:"a",target:null};listener(state);expect(tabs.getSnapshot()).toEqual({title:"360: Image a",onScreen:true});
    expect(tabs.panorama.textContent).toContain("Fixture photographer");expect(tabs.panorama.querySelector("a")).toBeNull();
    tabs.panorama.querySelector<HTMLButtonElement>("button")!.click();expect(activateAction).toHaveBeenCalledWith("next");tabs.leave();expect(exit).toHaveBeenCalledOnce();
    tabs.destroy();tabs.destroy();expect(off).toHaveBeenCalledOnce();expect(destroy).toHaveBeenCalledTimes(8);listener({phase:"overview",active:null,target:null});expect(tabs.getSnapshot().title).toBe("360: Image a");
  });
});
