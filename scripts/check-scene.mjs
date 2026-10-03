#!/usr/bin/env node
/**
 * Checks a scene manifest on disk before it is published: validates it as the
 * loader would (validateScene), then checks every media file it names against
 * what it declares (checkSceneFiles): the file exists, its header gives the
 * declared type and pixel size, and a representation's files add up to its
 * encodedBytes. A preview sheet is decoded and each face in it held against
 * the cube's own face file: it has to be the same picture. Nothing is fetched
 * from the network.
 *
 *   node scripts/check-scene.mjs tour/scene.json --base-url https://example.org/tour/scene.json
 *
 * Options:
 *   --base-url url   the address the manifest will be served from. Relative media URLs
 *                    resolve against it, and a URL under its folder is read from the
 *                    manifest's folder on disk. Default: https://scene.invalid/<file name>,
 *                    which suits a scene whose media URLs are all relative.
 *   --json file      also write the report there as JSON
 *
 * A media URL outside the base URL's folder cannot be read from disk and fails
 * the check. The limits are the loader's defaults, not a user's settings.
 * Exits 1 when the manifest is invalid or any file does not match.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runnerImport } from "vite";
import { verifyPreviewSheets } from "./lib/previewSheet.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { options.positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split("=", 2);
    if (name === "help") { options.help = true; continue; }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    options[name] = value;
  }
  return options;
}

/** Loads the scene modules through Vite's module runner, as the tests do, without a server. */
async function sceneModules() {
  const load = async file => (await runnerImport(path.join(root, file), { configFile: false, root, logLevel: "silent" })).module;
  const [{ validateScene }, { checkSceneFiles }] = await Promise.all([load("src/scenes/validateScene.ts"), load("src/scenes/checkSceneFiles.ts")]);
  return { validateScene, checkSceneFiles };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = options.positional[0];
  if (options.help || !manifestPath) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
    process.exit(options.help ? 0 : 1);
  }
  const baseUrl = new URL(options["base-url"] ?? `https://scene.invalid/${encodeURIComponent(path.basename(manifestPath))}`);
  const folderUrl = new URL(".", baseUrl);
  const folder = path.dirname(path.resolve(manifestPath));
  const { validateScene, checkSceneFiles } = await sceneModules();

  const text = readFileSync(manifestPath, "utf8");
  const result = validateScene(text, { baseUrl: baseUrl.href });
  const report = { manifest: manifestPath, baseUrl: baseUrl.href, ok: false, errors: [], warnings: [], problems: [], summary: null };
  if (!result.ok) {
    report.errors = result.errors;
  } else {
    const { scene } = result;
    report.warnings = scene.warnings;
    const outside = new Set();
    const read = url => {
      if (!url.startsWith(folderUrl.href)) { outside.add(url); return null; }
      const file = path.join(folder, decodeURIComponent(new URL(url).pathname.slice(folderUrl.pathname.length)));
      return existsSync(file) ? new Uint8Array(readFileSync(file)) : null;
    };
    const files = checkSceneFiles(scene, read);
    // The sheets' pictures, against the face files, by the validated scene's resolved URLs.
    const sheets = verifyPreviewSheets({
      sheets: [...scene.sheets.values()],
      assets: [...scene.assets.values()].map(asset => ({ id: asset.id, representations: asset.representations.filter(rep => rep.projection === "cube" && rep.sheet).map(rep => ({ id: rep.id, faceSize: rep.faceSize, faces: rep.faces, sheet: { id: rep.sheet.id, x: rep.sheet.x, y: rep.sheet.y } })) })),
    }, url => { const bytes = read(url); return bytes ? Buffer.from(bytes) : null; });
    // A sheet that does not exist is already reported by the file check.
    files.problems.push(...sheets.problems.filter(problem => !/ does not exist$/.test(problem.message)));
    // An outside URL reads as missing; say why instead.
    report.problems = files.problems.map(problem => {
      const url = [...outside].find(candidate => problem.message === `${candidate} does not exist`);
      return url ? { path: problem.path, message: `${url} is outside ${folderUrl.href}, so it cannot be read from ${folder}` } : problem;
    });
    const links = [...scene.panoramas.values()].reduce((sum, entity) => sum + entity.links.length, 0);
    report.summary = {
      id: scene.id, revision: scene.revision, title: scene.title, manifestBytes: scene.manifestBytes,
      panoramas: scene.panoramas.size, unsupported: scene.unsupported.size, assets: scene.assets.size, groups: scene.groups.length, links,
      files: files.files, mediaBytes: files.bytes, largestFile: files.largestFile,
      sheets: scene.sheets.size, sheetCubes: [...scene.assets.values()].reduce((sum, asset) => sum + asset.representations.filter(rep => rep.projection === "cube" && rep.sheet).length, 0),
      sheetLowestPsnrDb: Number.isFinite(sheets.lowestPsnrDb) ? Math.round(sheets.lowestPsnrDb * 10) / 10 : null,
    };
    report.ok = report.problems.length === 0;
  }
  if (options.json) writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);

  for (const error of report.errors) console.error(`error ${error.path}: ${error.message}`);
  for (const problem of report.problems) console.error(`file ${problem.path}: ${problem.message}`);
  for (const warning of report.warnings) console.warn(`warning ${warning.path}: ${warning.message}`);
  if (report.summary) {
    const s = report.summary;
    const mib = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
    console.log(`${report.ok ? "OK" : "FAILED"}: ${s.title} (${s.id}, revision ${s.revision})`);
    console.log(`  ${s.panoramas} panoramas, ${s.assets} images, ${s.groups} groups, ${s.links} links; manifest ${s.manifestBytes} bytes`);
    console.log(`  ${s.files} media files, ${mib(s.mediaBytes)}${s.largestFile ? `; largest ${mib(s.largestFile.bytes)}, ${s.largestFile.url}` : ""}`);
    if (s.sheets) console.log(`  ${s.sheets} preview ${s.sheets === 1 ? "sheet" : "sheets"} holding ${s.sheetCubes} cubes; its faces are within ${s.sheetLowestPsnrDb} dB of their files`);
  } else {
    console.log("FAILED: the manifest is not a valid scene");
  }
  process.exit(report.ok ? 0 : 1);
}

main().catch(error => {
  console.error(`check-scene: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
