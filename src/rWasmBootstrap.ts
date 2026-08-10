import { lucentInfo } from "./debug";
import { WASM_R_HOME, WEB_APP_DIR } from "./rwasm-constants";

/** Emscripten MODULARIZE factory exported as EXPORT_NAME=Rmain. */
type RmainFactory = (config: Record<string, unknown>) => Promise<RModule>;

/** Minimal view of the Emscripten in-memory filesystem used by the bootstrap. */
export interface EmscriptenFS {
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string, opts: { encoding: "utf8" }): string;
  readFile(path: string, opts: { encoding: "binary" }): Uint8Array;
  unlink(path: string): void;
  readdir(path: string): string[];
  analyzePath(path: string): { exists: boolean };
}

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  percent: number | null;
}

/** Minimal view of the initialized Rmain module (from rmain_post.js). */
export interface RModule {
  FS: EmscriptenFS;
  initR: (args?: string[]) => number;
  evalR: (code: string) => unknown;
  populateFilesystem: (options?: {
    metaUrl?: string;
    packagesBaseUrl?: string;
    concurrency?: number;
    onProgress?: (progress: DownloadProgress) => void;
  }) => Promise<unknown>;
  fetchUrls: (
    urls: string[],
    opts?: {
      concurrency?: number;
      onProgress?: (progress: DownloadProgress) => void;
      onDone?: (result: {
        url: string;
        arrayBuffer: ArrayBuffer | null;
        error: unknown;
      }) => void | Promise<void>;
    },
  ) => Promise<unknown>;
  extractArchiveFromMemory: (data: Uint8Array) => number;
  _rWasmEvalDepth: number;
  [key: string]: unknown;
}

export interface InitRModuleOptions {
  /** Base URL for `bin/Rmain.js` / `bin/Rmain.wasm`. */
  runtimeBaseUrl: string;
  /** URL of `empack_env_meta.json`. */
  empackMetaUrl: string;
  /** Base URL for package archives listed in the meta file. */
  empackPackagesBaseUrl: string;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  onDownloadProgress?: (progress: DownloadProgress) => void;
}

let evalRPostFlush: (() => void) | null = null;

export function setEvalRPostFlush(fn: () => void): void {
  evalRPostFlush = fn;
}

/** Ensure `url` is a directory URL (trailing slash) for reliable `new URL(rel, base)`. */
export function asDirectoryUrl(url: string): URL {
  const resolved = new URL(url, self.location.href);
  if (!resolved.pathname.endsWith("/")) {
    resolved.pathname += "/";
  }
  return resolved;
}

export function createRuntimeAssetUrls(runtimeBaseUrl: string): {
  glue: URL;
  wasm: URL;
  rLib: URL;
} {
  const base = asDirectoryUrl(runtimeBaseUrl);
  return {
    glue: new URL("bin/Rmain.js", base),
    wasm: new URL("bin/Rmain.wasm", base),
    /** Host mirror of `$PREFIX/lib/R/lib` for MAIN_MODULE dynlink before VFS populate. */
    rLib: new URL("lib/R/lib/", base),
  };
}

/** Cache of VFS path → blob: URL for SIDE_MODULE loads via locateFile. */
const vfsBlobUrls = new Map<string, string>();

function clearVfsBlobUrlCache(): void {
  for (const url of vfsBlobUrls.values()) {
    URL.revokeObjectURL(url);
  }
  vfsBlobUrls.clear();
}

function vfsFileToBlobUrl(module: RModule, vfsPath: string): string {
  const cached = vfsBlobUrls.get(vfsPath);
  if (cached) {
    return cached;
  }
  const data = module.FS.readFile(vfsPath, { encoding: "binary" });
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const url = URL.createObjectURL(new Blob([copy.buffer], { type: "application/wasm" }));
  vfsBlobUrls.set(vfsPath, url);
  return url;
}

function vfsExists(module: RModule, path: string): boolean {
  try {
    return module.FS.analyzePath(path).exists;
  } catch {
    return false;
  }
}

/**
 * Resolve an Emscripten dynlink `locateFile` argument to a VFS path that exists
 * after empack populate, or null if not found in the FS.
 */
export function resolveSideModuleVfsPath(module: RModule, file: string): string | null {
  const fileBase = file.split("/").pop() ?? file;
  const candidates: string[] = [];

  if (file.startsWith("/")) {
    candidates.push(file);
  }

  const pkgMatch = file.match(/(?:^|\/)library\/([^/]+)\/libs\/([^/]+)$/);
  if (pkgMatch) {
    candidates.push(`${WASM_R_HOME}/library/${pkgMatch[1]}/libs/${pkgMatch[2]}`);
  }

  candidates.push(`${WASM_R_HOME}/lib/${fileBase}`);
  candidates.push(`/lib/${fileBase}`);
  if (!file.startsWith("/")) {
    candidates.push(`/${file}`);
    candidates.push(`${WASM_R_HOME}/${file}`);
  }

  for (const path of candidates) {
    if (vfsExists(module, path)) {
      return path;
    }
  }
  return null;
}

/**
 * locateFile: Rmain.wasm over HTTP; SIDE_MODULE `.so` files from the VFS after
 * empack populate; before populate (MAIN_MODULE load of libR*.so), fall back to
 * HTTP under `runtime/lib/R/lib/` (same layout as the conda prefix).
 */
export function createFsBackedLocateFile(
  moduleRef: { current: RModule | null },
  runtimeBaseUrl: string,
): (file: string) => string {
  const { wasm, rLib } = createRuntimeAssetUrls(runtimeBaseUrl);
  return function locateFile(file: string): string {
    const fileBase = file.split("/").pop() ?? file;
    if (fileBase.endsWith(".wasm")) {
      return wasm.href;
    }

    const module = moduleRef.current;
    if (module?.FS) {
      const vfsPath = resolveSideModuleVfsPath(module, file);
      if (vfsPath) {
        return vfsFileToBlobUrl(module, vfsPath);
      }
    }

    // libR.so / libRblas.so / libRlapack.so are requested while instantiating
    // Rmain, before populateFilesystem has filled the VFS.
    return new URL(fileBase, rLib).href;
  };
}

/** Mirror R_HOME/lib/*.so to /lib for emscripten dynlink runtimePaths. */
export function mountRHomeLibToSlashLib(module: RModule): void {
  const libDir = `${WASM_R_HOME}/lib`;
  if (!vfsExists(module, libDir)) {
    lucentInfo("[rWasm] No", libDir, "to mirror into /lib");
    return;
  }
  module.FS.mkdirTree("/lib");
  let mirrored = 0;
  for (const name of module.FS.readdir(libDir)) {
    if (name === "." || name === ".." || !name.endsWith(".so")) {
      continue;
    }
    const src = `${libDir}/${name}`;
    const data = module.FS.readFile(src, { encoding: "binary" });
    module.FS.writeFile(`/lib/${name}`, data);
    mirrored += 1;
  }
  lucentInfo("[rWasm] Mirrored", mirrored, "*.so from", libDir, "→ /lib");
}

export function verifyMountedTree(module: RModule): void {
  const methodsSo = `${WASM_R_HOME}/library/methods/libs/methods.so`;
  if (!vfsExists(module, methodsSo)) {
    throw new Error(`Mounted FS is missing ${methodsSo}`);
  }
  const data = module.FS.readFile(methodsSo, { encoding: "binary" });
  if (!(data[0] === 0 && data[1] === 97 && data[2] === 115 && data[3] === 109)) {
    throw new Error(`${methodsSo} is not a wasm module (bad magic bytes)`);
  }
  if (!vfsExists(module, WEB_APP_DIR)) {
    throw new Error(`Mounted FS is missing ${WEB_APP_DIR} (empack pack dir/append webApp?)`);
  }
}

/** Load the MODULARIZE factory from Rmain.js (`EXPORT_ES6` + `EXPORT_NAME=Rmain`). */
async function loadRmainFactory(runtimeBaseUrl: string): Promise<RmainFactory> {
  const { glue: glueUrl } = createRuntimeAssetUrls(runtimeBaseUrl);
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

async function populateFromEmpack(
  module: RModule,
  {
    empackMetaUrl,
    empackPackagesBaseUrl,
    onDownloadProgress,
  }: Pick<InitRModuleOptions, "empackMetaUrl" | "empackPackagesBaseUrl" | "onDownloadProgress">,
): Promise<void> {
  if (typeof module.populateFilesystem !== "function") {
    throw new Error(
      "Module.populateFilesystem missing; rebuild r-main with the parameterized rmain_post.js",
    );
  }
  lucentInfo("[rWasm] populateFilesystem", empackMetaUrl);
  await module.populateFilesystem({
    metaUrl: empackMetaUrl,
    packagesBaseUrl: empackPackagesBaseUrl,
    onProgress: onDownloadProgress,
  });
  // Older Rmain builds only extract `packages[]`. Empack `pack append` puts
  // extras (e.g. webApp.tar.gz) under `mounts[]` — extract those if still missing.
  await extractEmpackMountsIfNeeded(module, {
    empackMetaUrl,
    empackPackagesBaseUrl,
    onDownloadProgress,
  });
  clearVfsBlobUrlCache();
  mountRHomeLibToSlashLib(module);
  verifyMountedTree(module);
}

/**
 * Extract `empack_env_meta.mounts` archives when `/webApp` (or other mounts)
 * were not already populated by Module.populateFilesystem.
 */
async function extractEmpackMountsIfNeeded(
  module: RModule,
  {
    empackMetaUrl,
    empackPackagesBaseUrl,
    onDownloadProgress,
  }: Pick<InitRModuleOptions, "empackMetaUrl" | "empackPackagesBaseUrl" | "onDownloadProgress">,
): Promise<void> {
  if (vfsExists(module, WEB_APP_DIR)) {
    return;
  }
  const fetchUrls = module.fetchUrls as
    | ((
        urls: string[],
        opts?: {
          concurrency?: number;
          onProgress?: (p: DownloadProgress) => void;
          onDone?: (result: {
            url: string;
            arrayBuffer: ArrayBuffer | null;
            error: unknown;
          }) => void | Promise<void>;
        },
      ) => Promise<unknown>)
    | undefined;
  if (typeof fetchUrls !== "function" || typeof module.extractArchiveFromMemory !== "function") {
    return;
  }

  const metaHref = new URL(empackMetaUrl, self.location.href).href;
  const metaRes = await fetch(metaHref);
  if (!metaRes.ok) {
    throw new Error(`Failed to fetch ${metaHref}: HTTP ${metaRes.status}`);
  }
  const meta = (await metaRes.json()) as { mounts?: Array<{ filename?: string }> };
  const mounts = Array.isArray(meta.mounts) ? meta.mounts : [];
  if (mounts.length === 0) {
    return;
  }

  const baseHref = new URL(empackPackagesBaseUrl, self.location.href).href;
  const urls = mounts.map((m) => {
    if (!m?.filename) {
      throw new Error(`mount entry missing filename in ${metaHref}`);
    }
    return new URL(m.filename, baseHref).href;
  });

  lucentInfo("[rWasm] extracting", urls.length, "empack mount archive(s)");
  const errors: Array<{ url: string; error: unknown }> = [];
  await fetchUrls(urls, {
    concurrency: 5,
    onProgress: onDownloadProgress,
    onDone: async ({ url, arrayBuffer, error }) => {
      if (error || !arrayBuffer) {
        errors.push({ url, error: error ?? new Error("empty archive") });
        return;
      }
      try {
        module.extractArchiveFromMemory(new Uint8Array(arrayBuffer));
      } catch (extractError) {
        errors.push({ url, error: extractError });
      }
    },
  });
  if (errors.length > 0) {
    const detail = errors
      .map((e) => `${e.url}: ${e.error instanceof Error ? e.error.message : String(e.error)}`)
      .join("; ");
    throw new Error(`Failed to extract empack mounts: ${detail}`);
  }
}

function unloadTransportPackages(Module: RModule): void {
  // VFS remount does not reload namespaces already resident in memory.
  evalR(Module, `tryCatch({
  for (pkg in c("shiny", "httpuv")) {
    if (pkg %in% loadedNamespaces()) {
      tryCatch(unloadNamespace(pkg), error = function(e) {
        cat("[rWasm] unloadNamespace ", pkg, ": ", conditionMessage(e), "\\n", sep = "")
      })
    }
  }
}, error = function(e) NULL)`);
}

export async function remountRHome(
  Module: RModule,
  {
    empackMetaUrl,
    empackPackagesBaseUrl,
    onDownloadProgress,
  }: Pick<InitRModuleOptions, "empackMetaUrl" | "empackPackagesBaseUrl" | "onDownloadProgress">,
): Promise<void> {
  await populateFromEmpack(Module, {
    empackMetaUrl,
    empackPackagesBaseUrl,
    onDownloadProgress,
  });
  unloadTransportPackages(Module);
  lucentInfo("[rWasm] Remounted empack env from", empackMetaUrl);
}

export async function bootstrapRSession(Module: RModule): Promise<void> {
  const status = Module.initR(["--no-restore", "--no-save", "--vanilla"]);
  if (status !== 0) {
    throw new Error(`R init failed with status ${status}`);
  }

  evalR(Module, "suppressPackageStartupMessages(library(httpuv))");
  evalR(Module, 'setwd("/")');
  lucentInfo("[rWasm] R session ready");
}

/**
 * Load and initialize Rmain via the MODULARIZE factory, populate the FS from
 * empack archives (including an appended webApp), then init R.
 */
export async function initRModule({
  runtimeBaseUrl,
  empackMetaUrl,
  empackPackagesBaseUrl,
  print,
  printErr,
  onDownloadProgress,
}: InitRModuleOptions): Promise<RModule> {
  const moduleRef: { current: RModule | null } = { current: null };
  const locateFile = createFsBackedLocateFile(moduleRef, runtimeBaseUrl);
  const createRmain = await loadRmainFactory(runtimeBaseUrl);

  const module = {
    noInitialRun: true,
    _rWasmEvalDepth: 0,
    locateFile,
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

  moduleRef.current = module;

  try {
    await createRmain(module);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }

  await populateFromEmpack(module, {
    empackMetaUrl,
    empackPackagesBaseUrl,
    onDownloadProgress,
  });
  await bootstrapRSession(module);

  // httpuv bridge reads Module.httpuv / Module._rWasmEvalDepth from globalThis.
  globalThis.Module = module;
  return module;
}
