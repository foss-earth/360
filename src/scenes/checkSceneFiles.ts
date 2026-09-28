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
import type { SceneDiagnostic, ValidatedScene } from "./format";
import { checkImage } from "./imageHeaders";

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
  for (const asset of scene.assets.values()) {
    for (const representation of asset.representations) {
      const base = `$.assets[${asset.id}].representations[${representation.id}]`;
      const files = representation.projection === "cube"
        ? Object.entries(representation.faces).map(([face, url]) => ({ path: `${base}.faces.${face}`, url, width: representation.faceSize, height: representation.faceSize }))
        : [{ path: `${base}.url`, url: representation.url, width: representation.width, height: representation.height }];
      let total = 0;
      let complete = true;
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
        if (!report.largestFile || bytes.length > report.largestFile.bytes) report.largestFile = { url: file.url, bytes: bytes.length };
        const problem = checkImage(bytes, { mimeType: representation.mimeType, width: file.width, height: file.height }, null);
        if (problem) report.problems.push({ path: file.path, message: `${file.url} ${problem}` });
      }
      if (complete && total !== representation.encodedBytes) {
        report.problems.push({ path: `${base}.encodedBytes`, message: `declares ${representation.encodedBytes} bytes; the files hold ${total}` });
      }
    }
  }
  return report;
}
