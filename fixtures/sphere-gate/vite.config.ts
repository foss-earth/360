import { defaultClientConditions, defineConfig } from "vite";

/** Serves the sphere gate from source. Scratch stays out of the watch. */
export default defineConfig({
  resolve: {
    conditions: ["source", ...defaultClientConditions],
    preserveSymlinks: true,
    dedupe: ["@babylonjs/core"],
  },
  server: {
    watch: { ignored: ["**/build/**"] },
    fs: { allow: ["../.."] },
  },
});
