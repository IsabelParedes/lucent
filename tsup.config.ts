import { defineConfig } from "tsup";

// Host and worker entries are emitted as standalone browser bundles into dist/,
// served locally at /lucent/dist/{runApp.js,rWasmWorker.js}. The host loads the
// worker as a sibling module (new Worker(new URL("./rWasmWorker.js", ...))).
export default defineConfig({
  entry: {
    runApp: "src/runApp.ts",
    rWasmWorker: "src/rWasmWorker.ts",
  },
  outDir: "dist",
  format: ["esm"],
  target: "es2020",
  platform: "browser",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
