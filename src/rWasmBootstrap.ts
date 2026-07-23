import type { RMainModule } from "./rWasmEval";

/** Emscripten MODULARIZE factory exported as EXPORT_NAME=Rmain. */
type RmainFactory = (config: Record<string, unknown>) => Promise<RModule>;

/** Minimal view of the Emscripten in-memory filesystem used by the bootstrap. */
export interface EmscriptenFS {
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string, opts: { encoding: "utf8" }): string;
  readFile(path: string, opts: { encoding: "binary" }): Uint8Array;
  unlink(path: string): void;
  analyzePath(path: string): { exists: boolean };
}

/** Minimal view of the initialized Rmain module. */
export interface RModule extends RMainModule {
  FS: EmscriptenFS;
  _rWasmEvalDepth: number;
  [key: string]: unknown;
}

export interface InitRModuleOptions {
  /** Base URL of the site root (manifest, host prefix tree). */
  assetBaseUrl: string;
  httpuv?: unknown;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}

let evalRPostFlush: (() => void) | null = null;

export function setEvalRPostFlush(fn: () => void): void {
  evalRPostFlush = fn;
}

/** Host directory name under assetBaseUrl where the wasm prefix is served. */
export const HOST_PREFIX = "_env-wasm";

/** R_HOME inside the mounted prefix (VFS root is /). */
export const WASM_R_HOME = "/lib/R";

export const WEB_APP_DIR = "/webApp";
export const WEB_APP_R = `${WEB_APP_DIR}/app.R`;

const VFS_SKIP = new Set([`${WASM_R_HOME}/etc/ldpaths`, `${WASM_R_HOME}/etc/Makeconf`]);

interface AssetUrls {
  glue: URL;
  wasm: URL;
  manifest: URL;
}

function hostPrefixBase(baseUrl: string): URL {
  return new URL(`${HOST_PREFIX}/`, new URL(baseUrl, self.location.href));
}

export function createAssetUrls(baseUrl: string): AssetUrls {
  const base = new URL(baseUrl, self.location.href);
  const hostPrefix = hostPrefixBase(baseUrl);
  return {
    glue: new URL("bin/Rmain", hostPrefix),
    wasm: new URL("bin/Rmain.wasm", hostPrefix),
    manifest: new URL("_env-wasm-manifest.json", base),
  };
}

export function createLocateFile(baseUrl: string): (file: string) => string {
  const hostPrefix = hostPrefixBase(baseUrl);
  return function locateFile(file: string): string {
    const fileBase = file.split("/").pop() ?? file;
    if (fileBase.endsWith(".wasm")) {
      return new URL("bin/Rmain.wasm", hostPrefix).href;
    }
    const pkgMatch = file.match(/\/library\/([^/]+)\/libs\/([^/]+)$/);
    if (pkgMatch) {
      return new URL(`lib/R/library/${pkgMatch[1]}/libs/${pkgMatch[2]}`, hostPrefix).href;
    }
    return new URL(`lib/R/lib/${fileBase}`, hostPrefix).href;
  };
}

/** Map an absolute VFS path to the HTTP URL under the host prefix tree. */
export function vfsPathToFetchUrl(baseUrl: string, vfsPath: string): string {
  if (!vfsPath.startsWith("/")) {
    throw new Error(`Expected absolute VFS path: ${vfsPath}`);
  }
  return new URL(`${HOST_PREFIX}${vfsPath}`, new URL(baseUrl, self.location.href)).href;
}

export async function mountRHome(baseUrl: string): Promise<Map<string, Uint8Array>> {
  const fileCache = new Map<string, Uint8Array>();
  const { manifest } = createAssetUrls(baseUrl);

  const res = await fetch(manifest, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${manifest.href}: HTTP ${res.status}`);
  }
  const { files } = (await res.json()) as { files: string[] };
  console.info("[rWasm] Mounting", files.length, "files from manifest");

  let next = 0;
  await Promise.all(
    Array.from({ length: 32 }, async () => {
      while (next < files.length) {
        const dst = files[next++];
        if (VFS_SKIP.has(dst)) {
          continue;
        }
        const fetchUrl = vfsPathToFetchUrl(baseUrl, dst);
        const fileRes = await fetch(fetchUrl, { cache: "no-store" });
        if (!fileRes.ok) {
          throw new Error(`Failed to fetch ${fetchUrl}: HTTP ${fileRes.status}`);
        }
        fileCache.set(dst, new Uint8Array(await fileRes.arrayBuffer()));
      }
    }),
  );

  console.info("[rWasm] Cached", fileCache.size, "files");
  return fileCache;
}

export function writeCachedTree(module: RModule, fileCache: Map<string, Uint8Array>): void {
  for (const path of fileCache.keys()) {
    const parent = path.substring(0, path.lastIndexOf("/"));
    if (parent) {
      module.FS.mkdirTree(parent);
    }
  }
  for (const [path, data] of fileCache) {
    module.FS.writeFile(path, data);
  }
}

/** Mirror R_HOME/lib/*.so to /lib for emscripten dynlink runtimePaths (see Rtester.js). */
export function mountRHomeLibToSlashLib(
  module: RModule,
  fileCache: Map<string, Uint8Array>,
): void {
  const libPrefix = `${WASM_R_HOME}/lib/`;
  for (const [path, data] of fileCache) {
    if (!path.startsWith(libPrefix) || !path.endsWith(".so")) {
      continue;
    }
    const base = path.slice(libPrefix.length);
    module.FS.mkdirTree("/lib");
    module.FS.writeFile(`/lib/${base}`, data);
  }
}

export function verifyMountedTree(module: RModule): void {
  const methodsSo = `${WASM_R_HOME}/library/methods/libs/methods.so`;
  const info = module.FS.analyzePath(methodsSo);
  if (!info.exists) {
    throw new Error(`Mounted FS is missing ${methodsSo}`);
  }
  const data = module.FS.readFile(methodsSo, { encoding: "binary" });
  if (!(data[0] === 0 && data[1] === 97 && data[2] === 115 && data[3] === 109)) {
    throw new Error(`${methodsSo} is not a wasm module (bad magic bytes)`);
  }
}

/** Fetch Rmain glue and return the MODULARIZE factory (`EXPORT_NAME=Rmain`). */
async function loadRmainFactory(baseUrl: string): Promise<RmainFactory> {
  const { glue: glueUrl } = createAssetUrls(baseUrl);
  const src = await fetch(glueUrl).then((res) => {
    if (!res.ok) {
      throw new Error(`Failed to fetch ${glueUrl.href}: HTTP ${res.status}`);
    }
    return res.text();
  });
  // Evaluate in a function scope so `var Rmain = ...` does not need globalThis.
  const factory = new Function(`${src}\nreturn Rmain;`)() as RmainFactory;
  if (typeof factory !== "function") {
    throw new Error("Rmain factory missing; rebuild r-main with -sMODULARIZE=1 -sEXPORT_NAME=Rmain");
  }
  return factory;
}

export function evalR(Module: RModule, code: string): unknown {
  if (typeof Module.evalR !== "function") {
    throw new Error("Module.evalR is missing; Rmain was not built with rmain_post.js");
  }
  if (Module._rWasmEvalDepth > 0) {
    throw new Error("reentrant evalR");
  }
  Module._rWasmEvalDepth = 1;
  try {
    return Module.evalR(code);
  } finally {
    Module._rWasmEvalDepth = 0;
    evalRPostFlush?.();
  }
}

export async function remountRHome(Module: RModule, assetBaseUrl: string): Promise<void> {
  const fileCache = await mountRHome(assetBaseUrl);
  writeCachedTree(Module, fileCache);
  mountRHomeLibToSlashLib(Module, fileCache);
  verifyMountedTree(Module);
  // VFS remount does not reload namespaces already resident in memory.
  // Unload transport/plot packages so the next library() picks up new prefix files.
  evalR(Module, `tryCatch({
  for (pkg in c("shiny", "httpuv")) {
    if (pkg %in% loadedNamespaces()) {
      tryCatch(unloadNamespace(pkg), error = function(e) {
        cat("[rWasm] unloadNamespace ", pkg, ": ", conditionMessage(e), "\\n", sep = "")
      })
    }
  }
}, error = function(e) NULL)`);
  evalR(Module, `tryCatch({
  suppressPackageStartupMessages(library(shiny))
  drawBody <- deparse(body(getFromNamespace("drawPlot", "shiny")))
  resizeBody <- deparse(body(getFromNamespace("resizeSavedPlot", "shiny")))
  publishBody <- deparse(body(getFromNamespace("plotPublishPng", "shiny")))
  fileUrlBody <- deparse(body(ShinySession$public_methods$fileUrl))
  ok <- all(
    any(grepl("plotPublishPng", drawBody)),
    any(grepl("plotImgHasSrc", resizeBody)),
    any(grepl("wasmPublishFileUrl", publishBody)),
    any(grepl("wasmPublishFileUrl", fileUrlBody))
  )
  cat("[rWasm] shiny wasm plot patch:", ok, "\\n")
}, error = function(e) {
  cat("[rWasm] shiny reload check failed:", conditionMessage(e), "\\n")
})`);
  console.info("[rWasm] Remounted prefix from", assetBaseUrl);
}

export async function bootstrapRSession(Module: RModule): Promise<void> {
  const status = Module.initR(["--no-restore", "--no-save", "--vanilla"]);
  if (status !== 0) {
    throw new Error(`R init failed with status ${status}`);
  }

  evalR(Module, "2+4");

  evalR(Module, "suppressPackageStartupMessages(library(httpuv))");
  evalR(Module, 'setwd("/")');
  console.info("[rWasm] R session ready");
}

export function writeWebAppToVfs(Module: RModule, source: string): void {
  Module.FS.mkdirTree(WEB_APP_DIR);
  Module.FS.writeFile(WEB_APP_R, source);
  console.info("[rWasm] Wrote", WEB_APP_R, `(${source.length} bytes)`);
}

/** A single Shiny app file, path relative to the app directory. */
export interface WebAppFile {
  path: string;
  data: Uint8Array;
}

/** Write every app file (text + binary, with subdirectories) into /webApp. */
export function writeWebAppFilesToVfs(Module: RModule, files: WebAppFile[]): void {
  Module.FS.mkdirTree(WEB_APP_DIR);
  for (const file of files) {
    const rel = file.path.replace(/^\/+/, "");
    if (!rel || rel.includes("..")) {
      continue;
    }
    const dst = `${WEB_APP_DIR}/${rel}`;
    const parent = dst.substring(0, dst.lastIndexOf("/"));
    if (parent) {
      Module.FS.mkdirTree(parent);
    }
    Module.FS.writeFile(dst, file.data);
  }
  console.info("[rWasm] Wrote", files.length, "webApp file(s) into", WEB_APP_DIR);
}

/**
 * Load and initialize Rmain (main thread or worker) via the MODULARIZE factory.
 * Keeps globalThis.Module in sync for the httpuv bridge.
 */
export async function initRModule({
  assetBaseUrl,
  httpuv,
  print,
  printErr,
}: InitRModuleOptions): Promise<RModule> {
  const fileCache = await mountRHome(assetBaseUrl);
  const locateFile = createLocateFile(assetBaseUrl);
  const { wasm: wasmUrl } = createAssetUrls(assetBaseUrl);

  const [createRmain, wasmBinary] = await Promise.all([
    loadRmainFactory(assetBaseUrl),
    fetch(wasmUrl).then((res) => {
      if (!res.ok) {
        throw new Error(`Failed to fetch ${wasmUrl.href}: HTTP ${res.status}`);
      }
      return res.arrayBuffer();
    }),
  ]);

  // Same object is mutated by Emscripten; preRun closes over it for FS writes.
  const module = {
    noInitialRun: true,
    _rWasmEvalDepth: 0,
    wasmBinary,
    locateFile,
    httpuv: httpuv ?? globalThis.Module?.httpuv,
    preRun: [() => writeCachedTree(module, fileCache)],
    onAbort(reason: unknown) {
      throw new Error(`Rmain aborted: ${String(reason)}`);
    },
    print(text: unknown) {
      (print ?? console.log)(String(text));
    },
    printErr(text: unknown) {
      (printErr ?? console.error)(String(text));
    },
  } as unknown as RModule;

  try {
    await createRmain(module);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }

  writeCachedTree(module, fileCache);
  mountRHomeLibToSlashLib(module, fileCache);
  verifyMountedTree(module);
  await bootstrapRSession(module);

  // httpuv bridge reads Module.httpuv / Module._rWasmEvalDepth from globalThis.
  globalThis.Module = module;
  return module;
}
