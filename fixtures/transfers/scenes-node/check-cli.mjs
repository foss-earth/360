#!/usr/bin/env node
/** Check local v1 manifest/files. --base-url URL --json FILE. No server or network. */
import { writeFileSync } from "node:fs";
import { checkSceneManifest } from "./scene-check.mjs";
try {
  const argv = process.argv.slice(2), options = {}; let manifest;
  for (let n=0;n<argv.length;n++) {
    if (argv[n] === "--help") { console.log("foss-earth-check-scene MANIFEST [--base-url URL] [--json FILE]"); process.exitCode = 0; manifest = null; break; }
    if (!argv[n].startsWith("--")) { if (manifest) throw new Error(`unexpected argument ${argv[n]}`); manifest = argv[n]; continue; }
    const [key, inline] = argv[n].slice(2).split("=",2), value = inline ?? argv[++n];
    if (!["base-url","json"].includes(key) || value === undefined) throw new Error(`invalid --${key} argument`);
    options[key] = value;
  }
  if (manifest === undefined) throw new Error("a scene manifest file is required");
  if (manifest) {
    const report = checkSceneManifest(manifest, { baseUrl: options["base-url"] });
    if (options.json) writeFileSync(options.json, `${JSON.stringify(report,null,2)}\n`);
    for (const error of report.errors) console.error(`error ${error.path}: ${error.message}`);
    for (const problem of report.problems) console.error(`file ${problem.path}: ${problem.message}`);
    for (const warning of report.warnings) console.warn(`warning ${warning.path}: ${warning.message}`);
    console.log(`${report.ok ? "OK" : "FAILED"}: ${report.summary?.title ?? "invalid scene"}`);
    if (report.summary) console.log(`${report.summary.spheres} panoramas, ${report.summary.assets} images; ${report.summary.files} media files, ${report.summary.mediaBytes} bytes`);
    process.exitCode = report.ok ? 0 : 1;
  }
} catch (error) { console.error(`check-scene: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
