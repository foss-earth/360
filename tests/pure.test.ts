import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string };
const FORBIDDEN = /^(@babylonjs\/|@foss-earth\/(renderer|ui|engine)(\/|$)|react(-dom)?(\/|$))|\/(browser|babylon|input|viewer|panels|globe-browser)$/;

/** Value imports only; `import type`/`export type` are erased, anything else may run. */
function specifiers(file: string): string[] {
  const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const found = [...text.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[^;"']*?\s+from\s+)?"([^"]+)"/g)].filter(match => !match[1]).map(match => match[2]);
  return [...found, ...[...text.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map(match => match[1])];
}

function packageDirectory(name: string): string {
  if (name === packageJson.name) return root;
  for (let directory = root; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(directory) === directory) throw new Error(`${name} is not installed`);
  }
}

function resolvePackage(specifier: string): string {
  const [, name, subpath] = /^(@[^/]+\/[^/]+|[^/]+)(\/.*)?$/.exec(specifier)!;
  const directory = packageDirectory(name);
  const exports = (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { exports: Record<string, string | Record<string, string>> }).exports;
  const target = exports[subpath ? `.${subpath}` : "."];
  if (!target) throw new Error(`${specifier} is not exported`);
  const files = typeof target === "string" ? [target] : [target.source, target.import].filter(Boolean);
  const file = files.map(path => resolve(directory, path)).find(path => existsSync(path));
  if (!file) throw new Error(`${specifier} has no source or built file`);
  return file;
}

/** Every package specifier reachable by value from `entry`, through relative files and @foss-earth packages. */
function reachablePackages(entry: string): Set<string> {
  const seen = new Set<string>(), packages = new Set<string>(), pending = [entry];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiers(file)) {
      if (specifier.startsWith(".")) {
        const path = resolve(dirname(file), specifier), typescript = path.replace(/\.js$/, ".ts");
        pending.push(file.endsWith(".ts") && existsSync(typescript) ? typescript : path);
      } else {
        packages.add(specifier);
        if (specifier.startsWith("@foss-earth/") && !FORBIDDEN.test(specifier)) pending.push(resolvePackage(specifier));
      }
    }
  }
  return packages;
}

describe("entry boundaries", () => {
  it("keeps the root and core entries free of DOM, Babylon, renderer and ui imports at any depth", () => {
    for (const subpath of [".", "./core"]) {
      const entry = resolvePackage(subpath === "." ? packageJson.name : `${packageJson.name}/core`);
      const packages = [...reachablePackages(entry)];
      expect(packages.filter(specifier => FORBIDDEN.test(specifier)), subpath).toEqual([]);
      expect(packages.every(specifier => specifier.startsWith("@foss-earth/")), subpath).toBe(true);
    }
  });
  it("imports the root and core entries in node with no document or window", async () => {
    expect(typeof globalThis.document).toBe("undefined");
    expect(typeof globalThis.window).toBe("undefined");
    const [rootEntry, core] = await Promise.all([import("@foss-earth/sphere-image"), import("@foss-earth/sphere-image/core")]);
    expect(Object.keys(rootEntry).length).toBeGreaterThan(0);
    expect(Object.keys(core)).toEqual(Object.keys(rootEntry));
  });
});
