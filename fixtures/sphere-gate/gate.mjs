/**
 * Stage D panorama acceptance on actual WebGL 1, WebGL 2 and WebGPU.
 * Ad hoc evidence, not the pinned check:browser run. Safari is not claimed:
 * every gesture is a CDP event in headless Chrome.
 *
 * Writes 360/build/stage-d/{results.json,summary.md,shots/}.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, openHeadlessChrome } from "../../../browser-testing/src/headlessChrome.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const out = path.join(repo, "build/stage-d");
const shots = path.join(out, "shots");
const PORT = 4210;
const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const backends = (process.env.BACKENDS ?? "webgl,webgl2,webgpu").split(",").filter(Boolean);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

await rm(shots, { recursive: true, force: true });
await mkdir(shots, { recursive: true });

const viteBin = path.resolve(repo, "../node_modules/.bin/vite");
const vite = spawn(viteBin, ["--config", path.join(here, "vite.config.ts"), "--configLoader", "native", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
  cwd: here, stdio: ["ignore", "pipe", "pipe"],
});
let viteLog = "";
vite.stdout.on("data", chunk => { viteLog += chunk; });
vite.stderr.on("data", chunk => { viteLog += chunk; });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("vite did not start\n" + viteLog.slice(-2000))), 30000);
  const watch = chunk => { if (String(chunk).includes(String(PORT))) { clearTimeout(timer); resolve(); } };
  vite.stdout.on("data", watch);
  vite.stderr.on("data", watch);
  vite.on("exit", code => reject(new Error("vite exited " + code + "\n" + viteLog.slice(-2000))));
});

const results = { started: new Date().toISOString(), kind: "stage-d-panorama", adHoc: true, pinnedCheckBrowser: false, safari: false, runs: [] };

function summarise(recorded) {
  const lines = ["# Stage D panorama gate", "", `Started ${recorded.started}. Ad hoc Chrome evidence, not the pinned check:browser run. Safari was not used.`, ""];
  let pass = 0, fail = 0;
  for (const run of recorded.runs) {
    const failed = run.checks.filter(check => check.ok === false);
    pass += run.checks.length - failed.length;
    fail += failed.length;
    lines.push(`## ${run.backend}`, "", `${run.checks.length - failed.length} pass, ${failed.length} fail. Browser ${JSON.stringify(run.browser ?? null)}. ${JSON.stringify(run.info ?? {})}`, "");
    for (const check of failed) lines.push(`- FAIL ${check.name}: ${JSON.stringify(check.details).slice(0, 500)}`);
    if (run.wheel) lines.push("", `Wheel: ${JSON.stringify(run.wheel).slice(0, 500)}`);
    lines.push("");
  }
  lines.push(`Total ${pass} pass, ${fail} fail.`);
  return { pass, fail, text: lines.join("\n") };
}

for (const backend of backends) {
  const profile = path.join(out, "profiles", backend);
  await rm(profile, { recursive: true, force: true });
  const chrome = await openHeadlessChrome(profile, CHROME, ["--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=127.0.0.1;localhost",
    ...(backend === "webgpu" ? ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"] : [])],
  { timeouts: { startupMs: 30000, commandMs: 120000, closeMs: 10000, exitMs: 5000 } });
  const run = { backend, browser: chrome.version, checks: [], info: null, wheel: null, consoleErrors: [] };
  results.runs.push(run);
  try {
    const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method, body = {}) => chrome.send(method, body, sessionId);
    chrome.onEvent(message => {
      if (message.sessionId !== sessionId) return;
      if (message.method === "Runtime.exceptionThrown") run.consoleErrors.push(String(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text).slice(0, 500));
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        run.consoleErrors.push((message.params.args ?? []).map(arg => arg.value ?? arg.description ?? "").join(" ").slice(0, 500));
      }
    });
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
    await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
    const ev = expression => evaluate(chrome, sessionId, expression);
    const deadline = Date.now() + 30000;
    for (;;) {
      const ready = await ev("Boolean(window.__sphereGate?.ready)").catch(() => false);
      if (ready) break;
      if (Date.now() > deadline) throw new Error("gate page did not start\n" + viteLog.slice(-1500));
      await sleep(200);
    }
    const outcome = await ev(`window.__sphereGate.run(${JSON.stringify(backend)})`);
    run.info = outcome.info;
    run.checks.push(...outcome.checks);
    const prepared = await ev("window.__sphereGate.prepareWheel()");
    await sleep(200);
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: prepared.x, y: prepared.y, deltaX: 0, deltaY: -120, pointerType: "mouse" });
    await sleep(100);
    const wheeled = await ev("window.__sphereGate.finishWheel()");
    const wheelOk = wheeled.error < 0.25 && wheeled.camera.verticalFovDeg < prepared.fov && wheeled.color[0] > 200 && wheeled.color[2] < 40;
    run.wheel = { prepared, wheeled, ok: wheelOk };
    run.checks.push({ name: "a CDP wheel keeps the marker under the pointer", ok: wheelOk, details: { prepared, color: wheeled.color, error: wheeled.error, fov: wheeled.camera.verticalFovDeg } });
    run.checks.push({ name: "the page reported no console error", ok: run.consoleErrors.length === 0, details: { consoleErrors: run.consoleErrors.slice(0, 8) } });
    const shot = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(shots, `${backend}.png`), Buffer.from(shot.data, "base64"));
    const failed = run.checks.filter(check => !check.ok).length;
    console.log(`${backend}: ${run.checks.length - failed} pass, ${failed} fail`);
    for (const check of run.checks.filter(item => !item.ok)) console.log("  FAIL", check.name, JSON.stringify(check.details).slice(0, 300));
  } catch (error) {
    run.checks.push({ name: "the backend run finished", ok: false, details: { error: String(error?.stack ?? error).slice(0, 1500) } });
    console.log(`${backend} did not finish`, error);
  } finally {
    await chrome.close().catch(() => {});
  }
}

const summary = summarise(results);
results.pass = summary.pass;
results.fail = summary.fail;
await writeFile(path.join(out, "results.json"), JSON.stringify(results, null, 2));
await writeFile(path.join(out, "summary.md"), summary.text);
vite.kill("SIGTERM");
console.log(summary.text);
process.exit(summary.fail === 0 ? 0 : 1);
