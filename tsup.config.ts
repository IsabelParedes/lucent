import { defineConfig } from "tsup";

// Host, worker, and httpuv transport entries are emitted as standalone browser
// bundles into dist/, served at /lucent/dist/. The host loads the R worker as a
// sibling module; transportBaseUrl points here for httpuv-web.js /
// shiny-socket.js. httpuv-sw.js is also aliased to the site root for scope.
export default defineConfig({
  entry: {
    runApp: "src/runApp.ts",
    rWasmWorker: "src/rWasmWorker.ts",
    "httpuv-web": "src/httpuv/index.ts",
    "httpuv-sw": "src/httpuv/sw.ts",
    "shiny-socket": "src/httpuv/shiny-socket.ts",
  },
  outDir: "dist",
  format: ["esm"],
  target: "es2020",
  platform: "browser",
  dts: true,
  sourcemap: true,
  clean: true,
  // Service worker and injected scripts must be self-contained.
  splitting: false,
  treeshake: true,
});
