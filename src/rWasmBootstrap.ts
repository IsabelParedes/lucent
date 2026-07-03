import { injectRWasmEvalGlue } from "./rWasmEval";

/** Minimal view of the Emscripten in-memory filesystem used by the bootstrap. */
export interface EmscriptenFS {
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string, opts: { encoding: "utf8" }): string;
  readFile(path: string, opts: { encoding: "binary" }): Uint8Array;
  unlink(path: string): void;
  analyzePath(path: string): { exists: boolean };
}

/** Minimal view of the initialized R.wasm module. */
export interface RModule {
  FS: EmscriptenFS;
  evalR: (code: string) => unknown;
  callMain: (args: string[]) => number;
  loadDynamicLibraryAsync: (path: string) => Promise<void>;
  _rWasmEvalDepth: number;
  [key: string]: unknown;
}

export interface InitRModuleOptions {
  /** Absolute base URL where R, R.wasm, R_HOME/ and the manifest are served. */
  assetBaseUrl: string;
  httpuv?: unknown;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}

let evalRPostFlush: (() => void) | null = null;

export function setEvalRPostFlush(fn: () => void): void {
  evalRPostFlush = fn;
}

export const WASM_R_HOME = "/R_HOME";
export const WEB_APP_DIR = "/webApp";
export const WEB_APP_R = `${WEB_APP_DIR}/app.R`;

const VFS_SKIP = new Set([`${WASM_R_HOME}/etc/ldpaths`, `${WASM_R_HOME}/etc/Makeconf`]);

export function rEnv(): Record<string, string> {
  const wasmRHome = WASM_R_HOME;
  return {
    R_HOME: wasmRHome,
    R_LIBS: `${wasmRHome}/library`,
    R_LIBS_USER: "NULL",
    R_LIBS_SITE: "NULL",
    LD_LIBRARY_PATH: `${wasmRHome}/lib:/lib`,
  };
}

interface AssetUrls {
  glue: URL;
  wasm: URL;
  rHome: URL;
  rLib: URL;
  manifest: URL;
}

export function createAssetUrls(baseUrl: string): AssetUrls {
  const base = new URL(baseUrl, self.location.href);
  return {
    glue: new URL("R", base),
    wasm: new URL("R.wasm", base),
    rHome: new URL("R_HOME/", base),
    rLib: new URL("R_HOME/lib/", base),
    manifest: new URL("R_HOME-manifest.json", base),
  };
}

export function createLocateFile(baseUrl: string): (file: string) => string {
  const base = new URL(baseUrl, self.location.href);
  return function locateFile(file: string): string {
    const fileBase = file.split("/").pop() ?? file;
    if (fileBase.endsWith(".wasm")) {
      return new URL("R.wasm", base).href;
    }
    const pkgMatch = file.match(/\/library\/([^/]+)\/libs\/([^/]+)$/);
    if (pkgMatch) {
      return new URL(`R_HOME/library/${pkgMatch[1]}/libs/${pkgMatch[2]}`, base).href;
    }
    return new URL(`R_HOME/lib/${fileBase}`, base).href;
  };
}

function dstToFetchUrl(baseUrl: string, dst: string): string {
  const { rHome, rLib } = createAssetUrls(baseUrl);
  const prefix = `${WASM_R_HOME}/`;
  if (dst.startsWith(prefix)) {
    return new URL(dst.slice(prefix.length), rHome).href;
  }
  if (dst.startsWith("/lib/")) {
    return new URL(dst.slice(5), rLib).href;
  }
  throw new Error(`Unknown mount path: ${dst}`);
}

export async function mountRHome(baseUrl: string): Promise<Map<string, Uint8Array>> {
  const fileCache = new Map<string, Uint8Array>();
  const { manifest } = createAssetUrls(baseUrl);

  const res = await fetch(manifest);
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
        const fetchUrl = dstToFetchUrl(baseUrl, dst);
        const fileRes = await fetch(fetchUrl);
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

async function loadGlue(baseUrl: string): Promise<string> {
  const { glue: glueUrl } = createAssetUrls(baseUrl);
  let glue = await fetch(glueUrl).then((res) => {
    if (!res.ok) {
      throw new Error(`Failed to fetch ${glueUrl.href}: HTTP ${res.status}`);
    }
    return res.text();
  });

  const env = rEnv();
  const envLiteral = JSON.stringify(env);
  glue = glue.replace("var ENV={};", `var ENV=${envLiteral};`);
  glue = glue.replace(
    "var Module=typeof Module!=\"undefined\"?Module:{};",
    "var Module=globalThis.Module;",
  );
  glue = glue.replace(
    'env={USER:"web_user",LOGNAME:"web_user",PATH:"/",PWD:"/",HOME:"/home/web_user",LANG:lang,_:getExecutableName()};',
    `env={R_HOME:"${env.R_HOME}",R_LIBS:"${env.R_LIBS}",R_LIBS_USER:"${env.R_LIBS_USER}",R_LIBS_SITE:"${env.R_LIBS_SITE}",LD_LIBRARY_PATH:"${env.LD_LIBRARY_PATH}",USER:"web_user",LOGNAME:"web_user",PATH:"/",PWD:"/",HOME:"/home/web_user",LANG:lang,_:getExecutableName()};`,
  );
  glue = injectRWasmEvalGlue(glue);
  return glue;
}

export async function preloadWasmSideModules(
  module: RModule,
  fileCache: Map<string, Uint8Array>,
): Promise<void> {
  const libR = `${WASM_R_HOME}/lib/libR.so`;
  const paths = [...fileCache.keys()].filter((p) => p.endsWith(".so"));
  const ordered = [
    ...paths.filter((p) => p === libR),
    ...paths.filter((p) => p !== libR).sort(),
  ];
  console.info("[rWasm] Preloading", ordered.length, "WASM side modules");
  for (const path of ordered) {
    await module.loadDynamicLibraryAsync(path);
  }
}

export function evalR(Module: RModule, code: string): unknown {
  if (typeof Module.evalR !== "function") {
    throw new Error("Module.evalR is missing; check rWasmEval.ts glue patch");
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

export async function bootstrapRSession(Module: RModule): Promise<void> {
  const status = Module.callMain(["--no-restore", "--no-save", "-e", "2+4"]);
  if (status !== 0) {
    throw new Error(`R bootstrap failed with status ${status}`);
  }

  evalR(Module, "suppressPackageStartupMessages(library(httpuv))");
  evalR(Module, 'setwd("/")');
  console.info("[rWasm] R session ready");
}

export function writeWebAppToVfs(Module: RModule, source: string): void {
  Module.FS.mkdirTree(WEB_APP_DIR);
  Module.FS.writeFile(WEB_APP_R, source);
  console.info("[rWasm] Wrote", WEB_APP_R, `(${source.length} bytes)`);
}

/**
 * Load and initialize R.wasm in the current global scope (main thread or worker).
 */
export async function initRModule({
  assetBaseUrl,
  httpuv,
  print,
  printErr,
}: InitRModuleOptions): Promise<RModule> {
  const fileCache = await mountRHome(assetBaseUrl);
  const env = rEnv();
  const locateFile = createLocateFile(assetBaseUrl);
  const { wasm: wasmUrl } = createAssetUrls(assetBaseUrl);

  const [glue, wasmBinary] = await Promise.all([
    loadGlue(assetBaseUrl),
    fetch(wasmUrl).then((res) => {
      if (!res.ok) {
        throw new Error(`Failed to fetch ${wasmUrl.href}: HTTP ${res.status}`);
      }
      return res.arrayBuffer();
    }),
  ]);

  return new Promise<RModule>((resolve, reject) => {
    globalThis.Module = {
      noInitialRun: true,
      _rWasmEvalDepth: 0,
      wasmBinary,
      locateFile,
      ENV: env,
      httpuv: httpuv ?? globalThis.Module?.httpuv,
      preRun: [() => writeCachedTree(globalThis.Module as RModule, fileCache)],
      onRuntimeInitialized() {
        const module = globalThis.Module as RModule;
        writeCachedTree(module, fileCache);
        try {
          verifyMountedTree(module);
        } catch (err) {
          reject(err);
          return;
        }
        preloadWasmSideModules(module, fileCache)
          .then(() => bootstrapRSession(module))
          .then(() => resolve(module))
          .catch(reject);
      },
      onAbort(reason: unknown) {
        reject(new Error(`R.wasm aborted: ${String(reason)}`));
      },
      print(text: unknown) {
        (print ?? console.log)(String(text));
      },
      printErr(text: unknown) {
        (printErr ?? console.error)(String(text));
      },
    };

    try {
      globalThis.eval(glue);
    } catch (err) {
      reject(err);
    }
  });
}
