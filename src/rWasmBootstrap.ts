import { HOST_PREFIX, WASM_R_HOME, WEB_APP_DIR } from "./rwasm-constants";

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

/** Minimal view of the initialized Rmain module (initR / evalR from rmain_post.js). */
export interface RModule {
  FS: EmscriptenFS;
  initR: (args?: string[]) => number;
  evalR: (code: string) => unknown;
  _rWasmEvalDepth: number;
  [key: string]: unknown;
}

export interface InitRModuleOptions {
  /** Base URL of the site root (manifest, host prefix tree). */
  assetBaseUrl: string;
  /** Host directory name under assetBaseUrl for the wasm prefix tree. */
  hostPrefixDir?: string;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}

let evalRPostFlush: (() => void) | null = null;

export function setEvalRPostFlush(fn: () => void): void {
  evalRPostFlush = fn;
}

interface AssetUrls {
  glue: URL;
  wasm: URL;
  manifest: URL;
}

function resolveHostPrefixDir(hostPrefixDir?: string): string {
  return hostPrefixDir ?? HOST_PREFIX;
}

function hostPrefixBase(baseUrl: string, hostPrefixDir: string): URL {
  return new URL(`${hostPrefixDir}/`, new URL(baseUrl, self.location.href));
}

export function createAssetUrls(baseUrl: string, hostPrefixDir?: string): AssetUrls {
  const prefix = resolveHostPrefixDir(hostPrefixDir);
  const base = new URL(baseUrl, self.location.href);
  const hostPrefix = hostPrefixBase(baseUrl, prefix);
  return {
    glue: new URL("bin/Rmain.js", hostPrefix),
    wasm: new URL("bin/Rmain.wasm", hostPrefix),
    manifest: new URL(`${prefix}-manifest.json`, base),
  };
}

export function createLocateFile(
  baseUrl: string,
  hostPrefixDir?: string,
): (file: string) => string {
  const hostPrefix = hostPrefixBase(baseUrl, resolveHostPrefixDir(hostPrefixDir));
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
export function vfsPathToFetchUrl(
  baseUrl: string,
  vfsPath: string,
  hostPrefixDir?: string,
): string {
  if (!vfsPath.startsWith("/")) {
    throw new Error(`Expected absolute VFS path: ${vfsPath}`);
  }
  const prefix = resolveHostPrefixDir(hostPrefixDir);
  return new URL(`${prefix}${vfsPath}`, new URL(baseUrl, self.location.href)).href;
}

export async function mountRHome(
  baseUrl: string,
  hostPrefixDir?: string,
): Promise<Map<string, Uint8Array>> {
  const prefix = resolveHostPrefixDir(hostPrefixDir);
  const fileCache = new Map<string, Uint8Array>();
  const { manifest } = createAssetUrls(baseUrl, prefix);

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
        const fetchUrl = vfsPathToFetchUrl(baseUrl, dst, prefix);
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

/** Load the MODULARIZE factory from Rmain.js (`EXPORT_ES6` + `EXPORT_NAME=Rmain`). */
async function loadRmainFactory(
  baseUrl: string,
  hostPrefixDir?: string,
): Promise<RmainFactory> {
  const { glue: glueUrl } = createAssetUrls(baseUrl, hostPrefixDir);
  // Absolute same-origin URL; do not let the bundler try to resolve it at build time.
  const mod = (await import(/* webpackIgnore: true */ glueUrl.href)) as {
    default?: RmainFactory;
    Rmain?: RmainFactory;
  };
  const factory = mod.default ?? mod.Rmain;
  if (typeof factory !== "function") {
    throw new Error(
      "Rmain factory missing; rebuild r-main with -sMODULARIZE=1 -sEXPORT_NAME=Rmain -sEXPORT_ES6=1",
    );
  }
  return factory;
}

export function evalR(Module: RModule, code: string): unknown {
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

export async function remountRHome(
  Module: RModule,
  assetBaseUrl: string,
  hostPrefixDir?: string,
): Promise<void> {
  const fileCache = await mountRHome(assetBaseUrl, hostPrefixDir);
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
  console.info("[rWasm] Remounted prefix from", assetBaseUrl);
}

export async function bootstrapRSession(Module: RModule): Promise<void> {
  const status = Module.initR(["--no-restore", "--no-save", "--vanilla"]);
  if (status !== 0) {
    throw new Error(`R init failed with status ${status}`);
  }

  evalR(Module, "suppressPackageStartupMessages(library(httpuv))");
  evalR(Module, 'setwd("/")');
  console.info("[rWasm] R session ready");
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
  hostPrefixDir,
  print,
  printErr,
}: InitRModuleOptions): Promise<RModule> {
  const prefix = resolveHostPrefixDir(hostPrefixDir);
  const fileCache = await mountRHome(assetBaseUrl, prefix);
  const locateFile = createLocateFile(assetBaseUrl, prefix);
  const createRmain = await loadRmainFactory(assetBaseUrl, prefix);

  // Same object is mutated by Emscripten; preRun closes over it for FS writes.
  const module = {
    noInitialRun: true,
    _rWasmEvalDepth: 0,
    locateFile,
    preRun: [
      () => {
        writeCachedTree(module, fileCache);
        mountRHomeLibToSlashLib(module, fileCache);
      },
    ],
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

  verifyMountedTree(module);
  await bootstrapRSession(module);

  // httpuv bridge reads Module.httpuv / Module._rWasmEvalDepth from globalThis.
  globalThis.Module = module;
  return module;
}
