/**
 * The publication check of §2: a validated scene's media files against what
 * its manifest declares, before anyone loads it. Every file must exist, match
 * its representation's type and pixel size by its own header, and the files of
 * a representation must add up to its `encodedBytes`. The loader makes the same
 * checks on the responses it receives; this finds the failures first.
 *
 * Reading is the caller's: a file system for a scene on disk, or anything else
 * that turns a resolved URL into bytes, so the check makes no requests.
 */
import { PREVIEW_SHEETS_EXTENSION, type ResolvedTiledCube, type SceneDiagnostic, type ValidatedScene } from "./format";
import { checkImage } from "./imageHeaders";
import { createCubeTiling } from "./tiles/cubeTiling";

export interface SceneFileReport {
  /** Paths name the asset and representation, such as `$.assets[garden].representations[preview-64].faces.px`. */
  problems: SceneDiagnostic[];
  /** Files read, and their bytes; a file shared by two representations counts in each. */
  files: number;
  bytes: number;
  /** The largest single file, which the `scene.panorama.responseMiB` limit applies to. */
  largestFile: { url: string; bytes: number } | null;
}

/** `read` returns a file's bytes, or null when it does not exist. */
export function checkSceneFiles(scene: ValidatedScene, read: (url: string) => Uint8Array | null): SceneFileReport {
  const report: SceneFileReport = { problems: [], files: 0, bytes: 0, largestFile: null };
  // A sheet is one file of the declared type, size and bytes; whether it shows its cubes' faces takes a decoder (scripts/check-scene.mjs).
  for (const sheet of scene.sheets.values()) {
    const path = `$.extensions.${PREVIEW_SHEETS_EXTENSION}.sheets[${sheet.id}]`;
    const bytes = read(sheet.url);
    if (!bytes) { report.problems.push({ path: `${path}.url`, message: `${sheet.url} does not exist` }); continue; }
    report.files += 1;
    report.bytes += bytes.length;
    if (!report.largestFile || bytes.length > report.largestFile.bytes) report.largestFile = { url: sheet.url, bytes: bytes.length };
    const problem = checkImage(bytes, { mimeType: sheet.mimeType, width: sheet.width, height: sheet.height }, null);
    if (problem) report.problems.push({ path: `${path}.url`, message: `${sheet.url} ${problem}` });
    if (bytes.length !== sheet.encodedBytes) report.problems.push({ path: `${path}.encodedBytes`, message: `declares ${sheet.encodedBytes} bytes; the file holds ${bytes.length}` });
  }
  for (const asset of scene.assets.values()) {
    for (const representation of asset.representations) {
      const base = `$.assets[${asset.id}].representations[${representation.id}]`;
      const files: { path: string; url: string; width: number; height: number; level?: number }[] = representation.projection === "cube"
        ? Object.entries(representation.faces).map(([face, url]) => ({ path: `${base}.faces.${face}`, url, width: representation.faceSize, height: representation.faceSize }))
        : representation.projection === "tiled-cube" ? tileFiles(representation, base)
          : [{ path: `${base}.url`, url: representation.url, width: representation.width, height: representation.height }];
      let total = 0;
      let complete = true;
      const levelTotals: number[] = [];
      for (const file of files) {
        const bytes = read(file.url);
        if (!bytes) {
          report.problems.push({ path: file.path, message: `${file.url} does not exist` });
          complete = false;
          continue;
        }
        report.files += 1;
        report.bytes += bytes.length;
        total += bytes.length;
        if (file.level !== undefined) levelTotals[file.level] = (levelTotals[file.level] ?? 0) + bytes.length;
        if (!report.largestFile || bytes.length > report.largestFile.bytes) report.largestFile = { url: file.url, bytes: bytes.length };
        const problem = checkImage(bytes, { mimeType: representation.mimeType, width: file.width, height: file.height }, null);
        if (problem) report.problems.push({ path: file.path, message: `${file.url} ${problem}` });
      }
      if (complete && total !== representation.encodedBytes) {
        report.problems.push({ path: `${base}.encodedBytes`, message: `declares ${representation.encodedBytes} bytes; the files hold ${total}` });
      }
      if (complete && representation.projection === "tiled-cube") {
        representation.levelBytes.forEach((declared, level) => {
          if (levelTotals[level] !== declared) report.problems.push({ path: `${base}.levelBytes[${level}]`, message: `declares ${declared} bytes; level ${level}'s tiles hold ${levelTotals[level] ?? 0}` });
        });
      }
    }
  }
  return report;
}

/** Every tile of a tiled cube, each the stored size. */
function tileFiles(representation: ResolvedTiledCube, base: string): { path: string; url: string; width: number; height: number; level: number }[] {
  const tiling = createCubeTiling({ warp: representation.warp, tileSize: representation.tileSize, maxLevel: representation.levelBytes.length - 1, gutter: representation.gutter });
  const extension = representation.mimeType === "image/png" ? "png" : "jpg";
  return Array.from({ length: tiling.count }, (_, tile) => {
    const path = `${tiling.path(tile)}.${extension}`;
    return { path: `${base}.tiles[${path}]`, url: `${representation.url}${path}`, width: tiling.stored, height: tiling.stored, level: tiling.level(tile) };
  });
}
