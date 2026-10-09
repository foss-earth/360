/** Local publication check composed from the envelope, common headers and leaf owners. */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { checkImage } from "@foss-earth/images";
import { validateScene } from "@foss-earth/scenes";
import { createPreviewSheetsExtensionHook } from "@foss-earth/preview-sheets/scene-extension";
import { PREVIEW_SHEETS_EXTENSION, verifyPreviewSheets } from "@foss-earth/preview-sheets/preparation";
import { tiledCubeFilesWithLevel } from "@foss-earth/tiled-cubemap";
import { createBuiltInRepresentations, validateViewerAsset } from "@foss-earth/360";

const within = (folder, file) => { const relative = path.relative(folder, file); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
/** Both decoded URL traversal and symlinks must remain inside the supplied local folder. */
export function localSceneReader(folder, baseUrl) {
  const root = realpathSync(folder), served = new URL(".", baseUrl), outside = new Set();
  return { outside, read(url) {
    let file;
    try {
      const parsed = new URL(url);
      if (parsed.origin !== served.origin || !parsed.pathname.startsWith(served.pathname)) { outside.add(url); return null; }
      file = path.resolve(root, decodeURIComponent(parsed.pathname.slice(served.pathname.length)));
      if (!within(root, file)) { outside.add(url); return null; }
      if (!existsSync(file)) return null;
      const actual = realpathSync(file);
      if (!within(root, actual)) { outside.add(url); return null; }
      return statSync(actual).isFile() ? new Uint8Array(readFileSync(actual)) : null;
    } catch { return null; }
  } };
}

export function checkSceneFiles(scene, read, representations) {
  const report = { problems: [], files: 0, bytes: 0, largestFile: null };
  function file(declared, field) {
    const bytes = read(declared.url);
    if (!bytes) { report.problems.push({ path: field, message: `${declared.url} does not exist` }); return null; }
    report.files++; report.bytes += bytes.length;
    if (!report.largestFile || bytes.length > report.largestFile.bytes) report.largestFile = { url: declared.url, bytes: bytes.length };
    const error = checkImage(bytes, declared, null);
    if (error) report.problems.push({ path: field, message: `${declared.url} ${error}` });
    return bytes.length;
  }
  const sheets = scene.extensionData.get(PREVIEW_SHEETS_EXTENSION) ?? new Map();
  for (const sheet of sheets.values()) {
    const field = `$.extensions.${PREVIEW_SHEETS_EXTENSION}.sheets[${sheet.id}]`, bytes = file(sheet, `${field}.url`);
    if (bytes !== null && bytes !== sheet.encodedBytes) report.problems.push({ path: `${field}.encodedBytes`, message: `declares ${sheet.encodedBytes} bytes; the file holds ${bytes}` });
  }
  for (const asset of scene.assets.values()) for (const representation of asset.representations) {
    const hook = representations.find(entry => entry.projection === representation.projection);
    if (!hook) throw new Error(`Missing public file hook for ${representation.projection}.`);
    const field = `$.assets[${asset.id}].representations[${representation.id}]`;
    // Level address calculation stays in tiled-cubemap; this tool only sums declared file groups.
    const files = representation.projection === "tiled-cube" ? tiledCubeFilesWithLevel(representation) : hook.files(representation);
    let complete = true, total = 0; const levelTotals = [];
    for (const declared of files) {
      const bytes = file(declared, `${field}.files[${declared.url}]`);
      if (bytes === null) { complete = false; continue; }
      total += bytes;
      if (declared.level !== undefined) levelTotals[declared.level] = (levelTotals[declared.level] ?? 0) + bytes;
    }
    if (complete && total !== representation.encodedBytes) report.problems.push({ path: `${field}.encodedBytes`, message: `declares ${representation.encodedBytes} bytes; the files hold ${total}` });
    if (complete && representation.projection === "tiled-cube") representation.levelBytes.forEach((declared, level) => {
      if ((levelTotals[level] ?? 0) !== declared) report.problems.push({ path: `${field}.levelBytes[${level}]`, message: `declares ${declared} bytes; level ${level}'s tiles hold ${levelTotals[level] ?? 0}` });
    });
  }
  return report;
}

export function checkSceneManifest(manifestPath, options = {}) {
  const baseUrl = new URL(options.baseUrl ?? `https://scene.invalid/${encodeURIComponent(path.basename(manifestPath))}`);
  // Estimates are unused during validation/file checking; explicit values avoid creating runtime budgets.
  const catalogue = createBuiltInRepresentations(() => ({ tileMemoryBytes: 0, responseBytes: 0, requests: 0, waiting: 0, uploadOutstandingBytes: 0 }));
  const representations = catalogue.map(entry => entry.hooks);
  const result = validateScene(readFileSync(manifestPath, "utf8"), { baseUrl: baseUrl.href, representations, validateImageAsset: validateViewerAsset, extensionHooks: [createPreviewSheetsExtensionHook()] });
  const report = { manifest: manifestPath, baseUrl: baseUrl.href, ok: false, errors: [], warnings: [], problems: [], summary: null };
  if (!result.ok) { report.errors = result.errors; return report; }
  const { scene } = result; report.warnings = scene.warnings;
  const reader = localSceneReader(path.dirname(path.resolve(manifestPath)), baseUrl);
  const files = checkSceneFiles(scene, reader.read, representations);
  const sheetRecords = scene.extensionData.get(PREVIEW_SHEETS_EXTENSION) ?? new Map();
  const sheetDocument = {
    extensions: { [PREVIEW_SHEETS_EXTENSION]: { sheets: [...sheetRecords.values()] } },
    assets: [...scene.assets.values()].map(asset => ({ ...asset, representations: asset.representations.map(rep => rep.sheet ? { ...rep, extensions: { ...rep.extensions, [PREVIEW_SHEETS_EXTENSION]: { id: rep.sheet.id, x: rep.sheet.x, y: rep.sheet.y } } } : rep) })),
  };
  const sheets = verifyPreviewSheets(sheetDocument, url => { const bytes = reader.read(url); return bytes ? Buffer.from(bytes) : null; });
  files.problems.push(...sheets.problems.filter(problem => !/ does not exist$/.test(problem.message)), ...scene.warnings.filter(warning => warning.path.includes(`extensions.${PREVIEW_SHEETS_EXTENSION}`)));
  report.problems = files.problems.map(problem => {
    const url = [...reader.outside].find(candidate => problem.message === `${candidate} does not exist`);
    return url ? { path: problem.path, message: `${url} is outside ${new URL(".", baseUrl).href}, so it cannot be read from the manifest folder` } : problem;
  });
  report.summary = { id: scene.id, revision: scene.revision, title: scene.title, manifestBytes: scene.manifestBytes,
    panoramas: scene.panoramas.size, unsupported: scene.unsupported.size, assets: scene.assets.size, groups: scene.groups.length,
    links: [...scene.panoramas.values()].reduce((sum, entity) => sum + entity.links.length, 0),
    files: files.files, mediaBytes: files.bytes, largestFile: files.largestFile, sheets: sheetRecords.size,
    sheetCubes: [...scene.assets.values()].reduce((sum, asset) => sum + asset.representations.filter(rep => !!rep.sheet).length, 0),
    sheetLowestPsnrDb: Number.isFinite(sheets.lowestPsnrDb) ? Math.round(sheets.lowestPsnrDb*10)/10 : null };
  report.ok = report.problems.length === 0; return report;
}
