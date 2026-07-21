import { LUCENT_CONFIG_PARAM, resolveLucentConfig, type LucentConfig } from "./config";
import { RWASM } from "./rwasm-constants";
import { loadTransport, type HttpuvTransport } from "./transport";
import { connectHttpuvComlink } from "./wiring";

const SETUP_WASM_PLOT_CACHE_R = `tryCatch({
  cacheDir <- "/tmp/shiny-plots"
  dir.create(cacheDir, showWarnings = FALSE, recursive = TRUE)
  options(shiny.wasm.plotUrl = TRUE)
  options(shiny.wasm.plotCacheDir = cacheDir)
  options(shiny.wasm.plotUrlPrefix = "shiny-plots")
  shiny::addResourcePath("shiny-plots", cacheDir)
}, error = function(e) warning("wasm plot cache setup: ", conditionMessage(e)))`;

const RUN_WEB_APP_R = `shiny::startApp(appDir = "webApp", port = 3838L, host = "127.0.0.1", launch.browser = FALSE, quiet = TRUE)`;

const config: LucentConfig = resolveLucentConfig();

let transport: HttpuvTransport | null = null;
let rWorker: Worker | null = null;
let rWorkerPromise: Promise<Worker> | null = null;
let comlinkConnected = false;
let comlinkPromise: Promise<void> | null = null;
let swRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
let httpuvReadyPromise: Promise<void> | null = null;
let evalSeq = 0;

const HTTPUV_SW_RELOAD_KEY = "httpuv-sw-reload";

interface RWorkerMessage {
  id?: string;
  type?: string;
  level?: string;
  text?: string;
  ok?: boolean;
  error?: string;
  message?: string;
  paths?: Record<string, string>;
}

function requireTransport(): HttpuvTransport {
  if (!transport) {
    throw new Error("[lucent] transport not loaded yet");
  }
  return transport;
}

/**
 * Absolute base URL under which the Shiny app is mounted. Deliberately NOT
 * derived from import.meta.url (the bundle lives in /lucent/dist/, which would
 * collide with real static files); defaults to the origin root → `/shiny/`.
 */
function shinyBaseUrl(): string {
  return new URL(config.shinyBaseUrl, self.location.href).href;
}

function shinyPrefix(): string {
  return requireTransport().resolveShinyPrefix(shinyBaseUrl());
}

function appUrl(subpath = ""): string {
  return requireTransport().shinyAppUrl(subpath, shinyBaseUrl());
}

function serviceWorkerScriptUrl(): URL {
  const base = new URL(config.transportBaseUrl, self.location.href);
  const url = new URL("httpuv-sw.js", base);
  // Tell the SW its mount prefix up-front so it intercepts correctly before the
  // REGISTER_HOST message arrives (avoids a first-load race on asset requests).
  url.searchParams.set("shinyPrefix", shinyPrefix());
  return url;
}

function announceHostToServiceWorker(): boolean {
  const t = requireTransport();
  const prefix = shinyPrefix();
  const msg = { type: t.MSG.REGISTER_HOST, shinyPrefix: prefix };
  const controller = navigator.serviceWorker.controller;
  if (controller) {
    controller.postMessage(msg);
    console.info("[httpuv] Announced host to service worker");
    return true;
  }
  return false;
}

async function waitForServiceWorkerController(
  timeoutMs = 3_000,
): Promise<ServiceWorker> {
  if (navigator.serviceWorker.controller) {
    return navigator.serviceWorker.controller;
  }

  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) {
    return navigator.serviceWorker.controller;
  }

  return new Promise((resolve, reject) => {
    let poll: ReturnType<typeof setInterval> | undefined;

    const deadline = setTimeout(() => {
      if (poll) clearInterval(poll);
      reject(new Error("timeout"));
    }, timeoutMs);

    const onController = () => {
      if (navigator.serviceWorker.controller) {
        clearTimeout(deadline);
        if (poll) clearInterval(poll);
        navigator.serviceWorker.removeEventListener("controllerchange", onController);
        resolve(navigator.serviceWorker.controller);
      }
    };

    navigator.serviceWorker.addEventListener("controllerchange", onController);
    poll = setInterval(onController, 100);
  });
}

async function waitForWorkerActivated(
  reg: ServiceWorkerRegistration,
  timeoutMs = 15_000,
): Promise<void> {
  await navigator.serviceWorker.ready;

  const worker = reg.installing ?? reg.waiting ?? reg.active;
  if (!worker) {
    return;
  }
  if (worker.state === "activated") {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onStateChange = () => {
      if (worker.state === "activated") {
        cleanup();
        resolve();
      }
    };

    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`Service worker activation timed out (state: ${worker.state})`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(deadline);
      worker.removeEventListener("statechange", onStateChange);
    };

    worker.addEventListener("statechange", onStateChange);

    if (worker.state === "activated") {
      cleanup();
      resolve();
    }
  });
}

async function registerHttpuvServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) {
    console.warn("[httpuv] Service workers are not supported in this browser");
    return null;
  }

  try {
    const reg = await navigator.serviceWorker.register(serviceWorkerScriptUrl(), {
      type: "module",
      scope: "/",
      updateViaCache: "none",
    });
    await waitForWorkerActivated(reg);

    if (!navigator.serviceWorker.controller) {
      const reloaded = sessionStorage.getItem(HTTPUV_SW_RELOAD_KEY);
      if (!reloaded) {
        sessionStorage.setItem(HTTPUV_SW_RELOAD_KEY, "1");
        console.info("[httpuv] Service worker installed — reloading once to activate");
        window.location.reload();
        await new Promise(() => {});
      }
      console.warn(
        "[httpuv] Page still not controlled after reload; check Application → Service Workers for httpuv-sw.js errors",
      );
    } else {
      sessionStorage.removeItem(HTTPUV_SW_RELOAD_KEY);
    }

    await waitForServiceWorkerController().catch(() => undefined);
    announceHostToServiceWorker();
    console.info("[httpuv] Service worker registered", {
      scope: reg.scope,
      shinyPrefix: shinyPrefix(),
      controller: Boolean(navigator.serviceWorker.controller),
    });
    return reg;
  } catch (err) {
    console.error("[httpuv] Service worker registration failed:", err);
    throw err;
  }
}

function ensureHttpuvServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!swRegistrationPromise) {
    swRegistrationPromise = registerHttpuvServiceWorker();
  }
  return swRegistrationPromise;
}

function postToRWorker(
  worker: Worker,
  msg: Record<string, unknown>,
  transfer: Transferable[] = [],
): Promise<RWorkerMessage> {
  const id = (msg.id as string | undefined) ?? `m${++evalSeq}`;
  const payload = { ...msg, id };

  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as RWorkerMessage | undefined;
      if (!data || data.id !== id) {
        if (data?.type === RWASM.LOG) {
          const fn = data.level === "error" ? console.error : console.log;
          fn(`[rWasmWorker] ${data.text}`);
        }
        if (data?.type === RWASM.ERROR && !msg.id) {
          worker.removeEventListener("message", onMessage);
          reject(new Error(data.message ?? "R worker failed"));
        }
        return;
      }

      if (
        data.type === RWASM.EVAL_RESULT ||
        data.type === RWASM.STOPPED ||
        data.type === RWASM.RESOURCE_PATHS
      ) {
        worker.removeEventListener("message", onMessage);
        if (data.type === RWASM.STOPPED || data.type === RWASM.RESOURCE_PATHS || data.ok) {
          resolve(data);
        } else {
          reject(new Error(data.error ?? "eval failed"));
        }
      }
    };

    worker.addEventListener("message", onMessage);
    worker.postMessage(payload, transfer);
  });
}

/**
 * Serialize the host's resolved config into an absolute-URL payload for the
 * worker. Base URLs are made absolute against the host page so the worker (which
 * lives at a different path, /lucent/dist/) resolves them identically — the host
 * is the single source of truth for config.
 */
function workerConfigParam(): string {
  const base = self.location.href;
  const abs = (u?: string): string | undefined => (u == null ? undefined : new URL(u, base).href);
  const payload: Partial<LucentConfig> = {
    transportBaseUrl: abs(config.transportBaseUrl),
    rRuntimeBaseUrl: abs(config.rRuntimeBaseUrl),
    shinyBaseUrl: abs(config.shinyBaseUrl),
    appDirUrl: abs(config.appDirUrl),
    appManifestUrl: abs(config.appManifestUrl),
  };
  return JSON.stringify(payload);
}

function createRWorker(): Promise<Worker> {
  const workerUrl = new URL("./rWasmWorker.js", import.meta.url);
  workerUrl.searchParams.set(LUCENT_CONFIG_PARAM, workerConfigParam());
  if (requireTransport().isHttpuvDebug()) {
    workerUrl.searchParams.set("httpuvDebug", "1");
  }
  const worker = new Worker(workerUrl, { type: "module" });

  return new Promise((resolve, reject) => {
    const onBoot = (event: MessageEvent) => {
      const data = event.data as RWorkerMessage | undefined;
      if (data?.type === RWASM.LOG) {
        const fn = data.level === "error" ? console.error : console.log;
        fn(`[rWasmWorker] ${data.text}`);
        return;
      }
      if (data?.type === RWASM.READY) {
        worker.removeEventListener("message", onBoot);
        console.info("[runApp] R.wasm worker ready");
        resolve(worker);
        return;
      }
      if (data?.type === RWASM.ERROR) {
        worker.removeEventListener("message", onBoot);
        reject(new Error(data.message ?? "R worker bootstrap failed"));
      }
    };

    worker.addEventListener("message", onBoot);
    worker.addEventListener("error", (event) => {
      worker.removeEventListener("message", onBoot);
      const detail = [event.message, event.filename, event.lineno]
        .filter(Boolean)
        .join(" ");
      reject(new Error(detail ? `R worker failed to load: ${detail}` : "R worker failed to load"));
    });
  });
}

async function ensureRWorker(): Promise<Worker> {
  if (rWorker) {
    return rWorker;
  }
  if (!rWorkerPromise) {
    rWorkerPromise = createRWorker().then((worker) => {
      rWorker = worker;
      return worker;
    });
  }
  return rWorkerPromise;
}

async function ensureComlinkConnected(): Promise<void> {
  if (comlinkConnected && comlinkPromise) {
    return comlinkPromise;
  }

  comlinkPromise = (async () => {
    console.info("[runApp] Waiting for R worker and service worker…");
    const [worker] = await Promise.all([ensureRWorker(), ensureHttpuvServiceWorker()]);
    if (!navigator.serviceWorker.controller) {
      throw new Error("Service worker controller is not available");
    }
    console.info("[runApp] Connecting Comlink…");
    await connectHttpuvComlink(worker, requireTransport().COMLINK.PORT_HANDOFF);
    comlinkConnected = true;
  })();

  return comlinkPromise;
}

function reconnectComlinkAfterServiceWorkerUpdate(): void {
  comlinkConnected = false;
  comlinkPromise = null;
  announceHostToServiceWorker();
  void ensureComlinkConnected().catch((err) => {
    console.warn("[httpuv] Comlink reconnect after service worker update failed:", err);
  });
}

export async function ensureHttpuvReady(): Promise<void> {
  if (!httpuvReadyPromise) {
    const t = requireTransport();
    t.setShinyPrefix(shinyPrefix());
    httpuvReadyPromise = ensureComlinkConnected();
  }
  return httpuvReadyPromise;
}

function stopRunningApp(): void {
  navigator.serviceWorker.controller?.postMessage({ type: requireTransport().MSG.STOP });

  if (rWorker) {
    rWorker.postMessage({ type: RWASM.STOP_APP });
  }
  console.info("[runApp] App stopped");
}

function loadViewerFrame(): void {
  const frame = document.getElementById("app-frame") as HTMLIFrameElement | null;
  const url = appUrl();
  if (frame) {
    frame.src = url;
  }
  console.info("[runApp] Viewer iframe →", url);
}

function clearAppDocumentCache(): void {
  navigator.serviceWorker.controller?.postMessage({
    type: requireTransport().MSG.CLEAR_APP_CACHE,
  });
}

async function syncResourcePathsToServiceWorker(worker: Worker): Promise<void> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    return;
  }

  try {
    const data = await postToRWorker(worker, { type: RWASM.GET_RESOURCE_PATHS });
    const paths = data.paths ?? {};
    controller.postMessage({ type: requireTransport().MSG.REGISTER_RESOURCE_PATHS, paths });
    if (Object.keys(paths).length > 0) {
      console.info("[runApp] synced", Object.keys(paths).length, "resource path(s) to SW");
    }
  } catch (err) {
    console.warn("[runApp] resource path sync failed; SW will use static fallbacks", err);
  }
}

async function waitForShinyHttpReady(worker: Worker): Promise<void> {
  const t = requireTransport();
  const url = appUrl();
  console.info("[runApp] Warming up Shiny (may take a minute on first load)…", url);
  const res = await fetch(url, {
    cache: "no-store",
    headers: { [t.WARMUP_REQUEST_HEADER]: "1" },
    signal: AbortSignal.timeout(t.REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Shiny warmup GET ${url} failed: HTTP ${res.status}`);
  }
  console.info("[runApp] Shiny warmup OK (HTTP", res.status + ")");
  await syncResourcePathsToServiceWorker(worker);
}

interface AppFile {
  path: string;
  data: Uint8Array;
}

function appDirUrl(): string {
  return config.appDirUrl ?? new URL("webApp/", self.location.href).href;
}

/**
 * Resolve the list of app files. A browser cannot enumerate a directory over
 * HTTP, so we rely on a `manifest.json` ({ files: string[] }) alongside the app.
 * The local dev server (serve.mjs) generates this automatically; static hosts
 * can ship one. Falls back to a lone `app.R` if no manifest is available.
 */
async function fetchAppFileList(dirUrl: string): Promise<string[]> {
  const manifestUrl = config.appManifestUrl ?? new URL("manifest.json", dirUrl).href;
  try {
    const res = await fetch(manifestUrl, { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { files?: unknown };
      if (Array.isArray(data.files) && data.files.length > 0) {
        return data.files.filter((f): f is string => typeof f === "string");
      }
      console.warn(`[runApp] app manifest ${manifestUrl} had no files; falling back to app.R`);
    } else {
      console.warn(`[runApp] app manifest ${manifestUrl} → HTTP ${res.status}; falling back to app.R`);
    }
  } catch (err) {
    console.warn("[runApp] app manifest fetch failed; falling back to app.R", err);
  }
  return ["app.R"];
}

async function loadAppFiles(): Promise<AppFile[]> {
  const dirUrl = appDirUrl();
  const list = await fetchAppFileList(dirUrl);
  const files = await Promise.all(
    list.map(async (rel): Promise<AppFile> => {
      const fileUrl = new URL(rel, dirUrl);
      const res = await fetch(fileUrl, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`Failed to fetch app file ${fileUrl.href}: HTTP ${res.status}`);
      }
      return { path: rel, data: new Uint8Array(await res.arrayBuffer()) };
    }),
  );
  console.info("[runApp] loaded", files.length, "app file(s) from", dirUrl);
  return files;
}

export async function runApp(files: AppFile[]): Promise<number> {
  if (files.length === 0) {
    console.warn("[runApp] No app files to run");
    return 1;
  }

  const worker = await ensureRWorker();

  clearAppDocumentCache();
  await postToRWorker(worker, { type: RWASM.STOP_APP });
  await postToRWorker(worker, { type: RWASM.REMOUNT_R_HOME });

  const transfer = files.map((f) => f.data.buffer as ArrayBuffer);
  await postToRWorker(worker, { type: RWASM.WRITE_WEB_APP_FILES, files }, transfer);

  console.info("[runApp] worker eval", SETUP_WASM_PLOT_CACHE_R);
  await postToRWorker(worker, {
    type: RWASM.EVAL,
    code: SETUP_WASM_PLOT_CACHE_R,
  });

  console.info("[runApp] worker eval", RUN_WEB_APP_R);
  await postToRWorker(worker, {
    type: RWASM.EVAL,
    code: RUN_WEB_APP_R,
  });

  return 0;
}

async function startShinyApp(): Promise<void> {
  await ensureHttpuvReady();
  const worker = await ensureRWorker();
  const files = await loadAppFiles();
  await runApp(files);
  await waitForShinyHttpReady(worker);
  await ensureComlinkConnected();
  loadViewerFrame();
}

function installHostServiceWorkerListeners(): void {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    reconnectComlinkAfterServiceWorkerUpdate();
  });

  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === requireTransport().MSG.REQUEST_COMLINK) {
      reconnectComlinkAfterServiceWorkerUpdate();
    }
  });
}

function installGlobalHelpers(): void {
  (globalThis as unknown as { __lucent?: unknown }).__lucent = {
    shinyUrl: (subpath = "") => appUrl(subpath),
    ensureHttpuvReady,
    stopRunningApp,
    enableHttpuvDebug: () => requireTransport().enableHttpuvDebug(),
    async testVirtualSocket(message = '{"method":"ping"}') {
      await ensureHttpuvReady();
      if (!navigator.serviceWorker.controller) {
        console.warn(
          "[lucent] No service worker controller — fetch may not be intercepted; unregister old workers and hard-refresh",
        );
      }

      const openUrl = new URL("__session__/open", appUrl());
      console.info("[lucent] testVirtualSocket: open", openUrl.href);
      const openRes = await fetch(openUrl, { method: "POST" });
      if (!openRes.ok) {
        throw new Error(`session open failed: HTTP ${openRes.status} ${await openRes.text()}`);
      }
      const { handle } = (await openRes.json()) as { handle: string };
      console.info("[lucent] testVirtualSocket: handle", handle);

      const recvUrl = new URL(`__session__/recv?handle=${encodeURIComponent(handle)}`, appUrl());
      const sendUrl = new URL(`__session__/send?handle=${encodeURIComponent(handle)}`, appUrl());
      const recvPromise = fetch(recvUrl);
      const sendRes = await fetch(sendUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: message,
      });
      if (!sendRes.ok && sendRes.status !== 204) {
        throw new Error(`session send failed: HTTP ${sendRes.status}`);
      }

      const recvRes = await recvPromise;
      const body = await recvRes.text();
      const result = { handle, status: recvRes.status, body };
      console.info("[lucent] testVirtualSocket: result", result);
      return result;
    },
  };
}

async function main(): Promise<void> {
  transport = await loadTransport(config.transportBaseUrl);
  transport.setShinyPrefix(shinyPrefix());

  installHostServiceWorkerListeners();
  installGlobalHelpers();

  if (transport.isHttpuvDebug()) {
    console.info("[runApp] httpuv debug tracing enabled (?httpuvDebug=1)");
  }

  // Register the service worker while R.wasm boots (do not block on the worker).
  void ensureHttpuvServiceWorker().catch((err) => {
    console.error("[httpuv] Service worker setup failed:", err);
  });

  await startShinyApp();
}

void main().catch((err) => {
  console.error("[runApp] Failed to start:", err);
});
