import * as Comlink from "comlink";

import { resolveLucentConfig } from "./config";
import {
  evalR,
  initRModule,
  remountRHome,
  setEvalRPostFlush,
  writeWebAppFilesToVfs,
  type RModule,
  type WebAppFile,
} from "./rWasmBootstrap";
import { RWASM } from "./rwasm-constants";
import { loadTransport, type ChannelMessageLike, type HttpuvTransport, type OutboundMessage } from "./transport";
import { createRHostApi, type HostInboundMessage, type SwDeliveryApi } from "./wiring";

const workerSelf = self as unknown as DedicatedWorkerGlobalScope;
const config = resolveLucentConfig();

// Unthrottled macrotask primitive. A MessageChannel task is not subject to the
// nested-setTimeout 4ms clamp or the background-tab timer throttling that would
// otherwise stretch every reactive hop (drain scheduling, HTTP push drain, and
// the idle service pump) once the tab is hidden. Order is preserved because a
// MessagePort delivers messages FIFO.
const macrotaskChannel = new MessageChannel();
const macrotaskQueue: Array<() => void> = [];
macrotaskChannel.port1.onmessage = () => {
  const cb = macrotaskQueue.shift();
  if (cb) {
    cb();
  }
};

/** Run `cb` on the next macrotask turn without timer clamping/throttling. */
function scheduleMacrotask(cb: () => void): void {
  macrotaskQueue.push(cb);
  macrotaskChannel.port2.postMessage(0);
}

interface RTask {
  work: () => void;
  resolve: () => void;
  reject: (err: unknown) => void;
}

const rTaskQueue: RTask[] = [];
let rDrainScheduled = false;
let rLocked = false;

const WASM_STOP_EXPR = `tryCatch({
  if (requireNamespace("shiny", quietly=TRUE) && shiny::isRunning()) {
    shiny::stopApp()
  }
}, error=function(e) NULL)`;

const WASM_SUSPEND_SHINY_LOOP =
  `tryCatch(shiny::suspendServiceLoop(), error=function(e) NULL)`;

const WASM_RESUME_SHINY_LOOP =
  `tryCatch(shiny::resumeServiceLoop(), error=function(e) NULL)`;

const WASM_SERVICE_ONCE =
  `tryCatch(shiny::serviceOnce(), error=function(e) NULL)`;

/** Service rounds after push idle wait (promise resolution only). */
const HTTP_PUSH_DRAIN_ROUNDS = 128;

/** Poll interval while waiting for emscripten later timers (no evalR). */
const HTTP_IDLE_POLL_MS = 16;

let httpDeliveryActive = false;
let httpDeliveryDraining = false;
let shinyLoopSuspended = false;

interface HttpDeliveryItem {
  req: HostInboundMessage;
  resolve: () => void;
  reject: (err: unknown) => void;
}

const httpDeliveryQueue: HttpDeliveryItem[] = [];

let activeHttpDrainUuid: string | null = null;
const httpDrainByUuid = new Map<string, { resolved: boolean }>();
let httpDeliveryInflight = 0;

/** Minimum spacing between idle service ticks (a real evalR is expensive). */
const PUMP_INTERVAL_MS = 16;

/** Keep the pump on the unthrottled macrotask loop this long after activity. */
const ACTIVE_WINDOW_MS = 2_000;

/** Idle-backoff cadence: once quiet, a plain timer is fine (nothing to pump). */
const IDLE_PUMP_MS = 96;

let pumpStarted = false;
let pumpScheduled = false;
let pumpViaMacrotask = false;
let pumpTimer: ReturnType<typeof setTimeout> | null = null;
let lastActivityTs = 0;
let lastPumpTickTs = 0;

let rAssetBaseUrl: string | null = null;
let transport: HttpuvTransport | null = null;
let rModule: RModule | null = null;
let rModulePromise: Promise<RModule> | null = null;
let swDelivery: Comlink.Remote<SwDeliveryApi> | null = null;
let rHostPortReady = false;
let swDeliveryPortReady = false;

/** Max time to wait for timer-fired handler before evalR drain. */
let HTTP_IDLE_MAX_MS = 30_000;

function requireTransport(): HttpuvTransport {
  if (!transport) {
    throw new Error("[lucent] transport not loaded yet");
  }
  return transport;
}

function requireRModule(): RModule {
  if (!rModule) {
    throw new Error("[lucent] R module not initialized yet");
  }
  return rModule;
}

function evalRNow(code: string): void {
  evalR(requireRModule(), code);
}

function dbg(stage: string, ...args: unknown[]): void {
  transport?.httpuvDebugLog(stage, ...args);
}

function postToHost(payload: unknown, transfer: Transferable[] = []): void {
  workerSelf.postMessage(payload, transfer);
}

function log(level: "log" | "error", text: unknown): void {
  const msg = String(text);
  if (level === "error" && msg.startsWith("Error")) {
    postToHost({ type: RWASM.LOG, level: "error", text: msg });
    return;
  }
  postToHost({ type: RWASM.LOG, level: "log", text: msg });
}

function maybeAnnounceComlinkReady(): void {
  if (rHostPortReady && swDeliveryPortReady) {
    postToHost({ type: RWASM.COMLINK_READY });
  }
}

function messageBodyLength(message: unknown): number {
  if (typeof message === "string") {
    return message.length;
  }
  if (message instanceof ArrayBuffer) {
    return message.byteLength;
  }
  if (ArrayBuffer.isView(message)) {
    return message.byteLength;
  }
  return 0;
}

function deliverToServiceWorker(outbound: OutboundMessage, transfer: Transferable[] = []): void {
  const t = requireTransport();
  if (!swDelivery) {
    console.warn("[rWasmWorker] Service worker delivery API not connected");
    return;
  }
  markActivity();

  if (outbound.type === t.MSG.HTTP_RESPONSE) {
    dbg("comlink-deliver-http", { uuid: outbound.uuid, status: outbound.status });
    const drainState = outbound.uuid ? httpDrainByUuid.get(outbound.uuid) : undefined;
    if (drainState) {
      drainState.resolved = true;
    }
    const resp = {
      uuid: outbound.uuid,
      status: outbound.status,
      headers: outbound.headers,
      body: outbound.body,
    };
    void swDelivery
      .deliverHttpResponse(transfer.length > 0 ? Comlink.transfer(resp, transfer) : resp)
      .catch((err: unknown) => {
        console.error("[rWasmWorker] deliverHttpResponse failed:", formatRWasmError(err), err);
      });
    return;
  }

  if (outbound.type === t.MSG.WS_PUSH) {
    const handle = t.normalizeSessionHandle(outbound.handle);
    const msg = {
      handle,
      binary: outbound.binary,
      wsType: outbound.wsType,
      message: outbound.message,
    };
    dbg("comlink-deliver-ws", {
      handle,
      wsType: outbound.wsType,
      binary: outbound.binary,
      messageLen: messageBodyLength(outbound.message),
    });
    void swDelivery
      .deliverWsPush(transfer.length > 0 ? Comlink.transfer(msg, transfer) : msg)
      .catch((err: unknown) => {
        console.error("[rWasmWorker] deliverWsPush failed:", formatRWasmError(err), err);
      });
  }
}

function formatRWasmError(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name;
  }
  const WasmException = (WebAssembly as unknown as { Exception?: new () => unknown }).Exception;
  if (typeof WasmException !== "undefined" && err instanceof WasmException) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) {
      return message;
    }
    return "WebAssembly.Exception (likely WASM trap during R eval)";
  }
  if (typeof err === "object" && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) {
      return message;
    }
    const text = String(err);
    if (text !== "[object Object]" && text !== "[object WebAssembly.Exception]") {
      return text;
    }
  }
  return String(err);
}

function scheduleRDrain(): void {
  if (rDrainScheduled) {
    return;
  }
  rDrainScheduled = true;
  scheduleMacrotask(drainRTaskQueue);
}

function drainRTaskQueue(): void {
  rDrainScheduled = false;
  if (!rModule || rTaskQueue.length === 0) {
    return;
  }

  const task = rTaskQueue.shift();
  if (!task) {
    return;
  }
  rLocked = true;
  try {
    task.work();
    task.resolve();
  } catch (err) {
    task.reject(err);
  } finally {
    rLocked = false;
    transport?.flushDeferredOutbound();
  }

  if (rTaskQueue.length > 0) {
    scheduleRDrain();
  }
}

/**
 * Queue work that calls evalR. Tasks run one at a time on setTimeout(0) turns
 * so later's emscripten timers can run while the worker is idle.
 */
function enqueueRTask(work: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    rTaskQueue.push({ work, resolve, reject });
    scheduleRDrain();
  });
}

function pushToR(msg: ChannelMessageLike): void {
  const t = requireTransport();
  if (msg?.uuid) {
    dbg("worker-push-evalR-begin", { uuid: msg.uuid });
  }
  if (
    msg?.type === t.CHANNEL.WS_OPEN ||
    msg?.type === t.CHANNEL.WS_MESSAGE ||
    msg?.type === t.CHANNEL.WS_CLOSE
  ) {
    dbg("worker-push-ws", {
      type: msg.type,
      handle: t.normalizeSessionHandle(msg.handle),
      binary: msg.binary,
      messageLen: messageBodyLength(msg.message),
    });
  }
  evalRNow(`tryCatch({
  ${t.channelMessageToRExpr(msg)}
}, error=function(e) {
  msg <- paste0("[httpuv] push failed (", ${JSON.stringify(String(msg.url ?? ""))}, "): ", conditionMessage(e))
  message(msg)
  stop(msg)
})`);
  if (msg?.uuid) {
    dbg("worker-push-evalR-finish", { uuid: msg.uuid });
  }
}

/** Yield between drain rounds so emscripten later timers can fire. */
const HTTP_DRAIN_YIELD_MS = 4;

function yieldMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Wait for the HTTP response with no evalR — emscripten later timers need a
 * quiet worker. Background pump is paused via httpDeliveryActive.
 */
async function idleWaitForHttpResponse(
  state: { resolved: boolean },
  uuid: string,
  maxMs = HTTP_IDLE_MAX_MS,
): Promise<void> {
  const start = Date.now();
  while (!state.resolved && Date.now() - start < maxMs) {
    await yieldMs(HTTP_IDLE_POLL_MS);
  }
  dbg("worker-push-idle-done", {
    uuid,
    resolved: state.resolved,
    waitedMs: Date.now() - start,
  });
}

function isStaticAssetUrl(url: string): boolean {
  return requireTransport().isLikelyStaticAsset(url);
}

function isSessionHttpUrl(url: string): boolean {
  const t = requireTransport();
  try {
    return t.isSessionHttpRequest(url, t.getShinyPrefix());
  } catch {
    return t.isSessionHttpRequest(url);
  }
}

async function ensureShinyLoopSuspended(): Promise<void> {
  if (shinyLoopSuspended || !rModule) {
    return;
  }
  await enqueueRTask(() => {
    evalRNow(WASM_SUSPEND_SHINY_LOOP);
  });
  shinyLoopSuspended = true;
  dbg("worker-shiny-loop-suspend", {});
}

async function ensureShinyLoopResumed(): Promise<void> {
  if (!shinyLoopSuspended || !rModule) {
    return;
  }
  await enqueueRTask(() => {
    evalRNow(WASM_RESUME_SHINY_LOOP);
  });
  shinyLoopSuspended = false;
  dbg("worker-shiny-loop-resume", {});
}

async function maybeFinishHttpDeliveryBatch(): Promise<void> {
  if (httpDeliveryQueue.length > 0 || httpDeliveryInflight > 0) {
    return;
  }
  await ensureShinyLoopResumed();
  httpDeliveryActive = false;
  httpDeliveryDraining = false;
}

async function deliverOneHttpRequest(req: HostInboundMessage): Promise<void> {
  const uuid = req.uuid ?? "";
  const url = req.url ?? "";
  const state = { resolved: false };
  httpDrainByUuid.set(uuid, state);
  httpDeliveryInflight++;
  activeHttpDrainUuid = uuid;

  const staticAsset = isStaticAssetUrl(url);
  const sessionHttp = isSessionHttpUrl(url);

  try {
    await enqueueRTask(() => {
      requireTransport().pushInboundHostMessage(req);
    });

    if (!staticAsset) {
      await idleWaitForHttpResponse(state, uuid, HTTP_IDLE_MAX_MS);

      if (!state.resolved) {
        await drainAfterHttpPush(HTTP_PUSH_DRAIN_ROUNDS, uuid, state);
      } else if (sessionHttp) {
        // Session send/open return 204/200 immediately while Shiny still
        // flushes outputs onto the virtual WebSocket via later.
        dbg("worker-session-drain", { uuid });
        await drainAfterHttpPush(HTTP_PUSH_DRAIN_ROUNDS, uuid, { resolved: false });
      }
    } else if (!state.resolved) {
      await yieldMs(HTTP_DRAIN_YIELD_MS);
    }
  } finally {
    httpDrainByUuid.delete(uuid);
    if (activeHttpDrainUuid === uuid) {
      activeHttpDrainUuid = null;
    }
    httpDeliveryInflight--;
  }
}

async function drainHttpDeliveryQueue(): Promise<void> {
  while (httpDeliveryQueue.length > 0) {
    const item = httpDeliveryQueue.shift();
    if (!item) {
      break;
    }
    const itemUrl = item.req.url ?? "";
    const needsSuspend = !isStaticAssetUrl(itemUrl) && !isSessionHttpUrl(itemUrl);
    if (needsSuspend && !shinyLoopSuspended) {
      await ensureShinyLoopSuspended();
    }
    if (needsSuspend) {
      httpDeliveryActive = true;
    }
    try {
      await deliverOneHttpRequest(item.req);
      item.resolve();
    } catch (err) {
      logHttpDeliveryError(err, itemUrl);
      item.reject(err);
    } finally {
      if (needsSuspend) {
        httpDeliveryActive = false;
      }
    }
    const next = httpDeliveryQueue[0];
    const nextUrl = next?.req.url ?? "";
    const nextNeedsSuspend = Boolean(
      next && !isStaticAssetUrl(nextUrl) && !isSessionHttpUrl(nextUrl),
    );
    if (shinyLoopSuspended && !nextNeedsSuspend) {
      await ensureShinyLoopResumed();
    }
  }

  await maybeFinishHttpDeliveryBatch();

  if (httpDeliveryQueue.length > 0 && !httpDeliveryDraining) {
    httpDeliveryDraining = true;
    void drainHttpDeliveryQueue();
  }
}

function drainAfterHttpPush(
  roundsLeft: number,
  uuid: string,
  state: { resolved: boolean },
): Promise<void> {
  if (roundsLeft <= 0 || !rModule || state.resolved) {
    if (!state.resolved) {
      dbg("worker-push-drain-exhausted", { uuid, roundsLeft });
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    scheduleMacrotask(() => {
      void enqueueRTask(() => {
        evalRNow(WASM_SERVICE_ONCE);
      })
        .then(() => drainAfterHttpPush(roundsLeft - 1, uuid, state))
        .then(resolve);
    });
  });
}

/**
 * Idle service pump. While there has been recent traffic it rides the
 * unthrottled macrotask loop (surviving background throttling); once quiet it
 * backs off to a plain timer so an idle app costs nothing. Real evalR ticks are
 * still spaced by PUMP_INTERVAL_MS; the macrotask turns in between are cheap.
 */
function schedulePump(viaMacrotask: boolean, delayMs = 0): void {
  if (pumpScheduled) {
    return;
  }
  pumpScheduled = true;
  pumpViaMacrotask = viaMacrotask;
  if (viaMacrotask) {
    scheduleMacrotask(() => {
      pumpScheduled = false;
      pumpOnce();
    });
  } else {
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pumpScheduled = false;
      pumpOnce();
    }, delayMs);
  }
}

function pumpOnce(): void {
  if (!rModule) {
    return;
  }

  const now = Date.now();
  if (
    now - lastPumpTickTs >= PUMP_INTERVAL_MS &&
    !rLocked &&
    rTaskQueue.length === 0 &&
    !httpDeliveryActive
  ) {
    lastPumpTickTs = now;
    void enqueueRTask(() => {
      evalRNow(WASM_SERVICE_ONCE);
    }).catch((err) => {
      console.warn("[rWasmWorker] later pump failed:", formatRWasmError(err));
    });
  }

  const active =
    now - lastActivityTs < ACTIVE_WINDOW_MS ||
    httpDeliveryInflight > 0 ||
    httpDeliveryQueue.length > 0;
  schedulePump(active, active ? 0 : IDLE_PUMP_MS);
}

/**
 * Note inbound/outbound traffic so the pump re-enters the unthrottled macrotask
 * loop promptly (rather than waiting out the current idle-backoff timer).
 */
function markActivity(): void {
  lastActivityTs = Date.now();
  if (pumpStarted && !pumpViaMacrotask && pumpTimer !== null) {
    clearTimeout(pumpTimer);
    pumpTimer = null;
    pumpScheduled = false;
    schedulePump(true, 0);
  }
}

function ensureRLaterPump(): void {
  if (pumpStarted) {
    return;
  }
  pumpStarted = true;
  lastActivityTs = Date.now();
  schedulePump(true, 0);
  dbg("later-pump", { intervalMs: PUMP_INTERVAL_MS, driver: "message-loop" });
}

function logHttpDeliveryError(err: unknown, url?: string): void {
  const where = url ? ` ${url}` : "";
  console.error(`[rWasmWorker] deliverHttpRequest failed:${where}`, formatRWasmError(err), err);
}

/**
 * Queue one HTTP request. Requests run strictly one-at-a-time; Shiny's
 * service loop is suspended once for the whole batch.
 */
function enqueueHttpDelivery(req: HostInboundMessage): Promise<void> {
  markActivity();
  dbg("worker-push", { uuid: req.uuid, method: req.method, url: req.url });

  return new Promise((resolve, reject) => {
    httpDeliveryQueue.push({ req, resolve, reject });
    if (!httpDeliveryDraining) {
      httpDeliveryDraining = true;
      void drainHttpDeliveryQueue().catch((err) => {
        httpDeliveryDraining = false;
        httpDeliveryActive = false;
        logHttpDeliveryError(err);
      });
    }
  });
}

function installBridge(t: HttpuvTransport): void {
  // Must match the host's mount prefix (config.shinyBaseUrl → `/shiny/`), NOT
  // import.meta.url: the worker bundle lives in /lucent/dist/, and this prefix
  // is baked into the app document's <base href>, which drives every relative
  // Shiny asset URL. Deriving it from the bundle path sends assets to
  // /lucent/dist/shiny/... where no files exist.
  const shinyBase = new URL(config.shinyBaseUrl, self.location.href).href;
  t.setShinyPrefix(t.resolveShinyPrefix(shinyBase));
  setEvalRPostFlush(() => t.flushDeferredOutbound());
  t.installHttpuvBridge({
    installSwListener: false,
    postOutbound: deliverToServiceWorker,
    pushToR: (msg) => {
      pushToR(msg);
    },
  });
}

async function initEverything(): Promise<RModule> {
  transport = await loadTransport(config.transportBaseUrl);
  HTTP_IDLE_MAX_MS = transport.REQUEST_TIMEOUT_MS;
  installBridge(transport);
  const assetBaseUrl = new URL(config.rRuntimeBaseUrl, self.location.href).href;
  rAssetBaseUrl = assetBaseUrl;
  const module = await initRModule({
    assetBaseUrl,
    hostPrefixDir: config.hostPrefixDir,
    httpuv: (globalThis.Module as { httpuv?: unknown } | undefined)?.httpuv,
    print: (text) => log("log", text),
    printErr: (text) => log("error", text),
  });
  rModule = module;
  ensureRLaterPump();
  return module;
}

function ensureRModule(): Promise<RModule> {
  if (!rModulePromise) {
    rModulePromise = initEverything();
  }
  return rModulePromise;
}

function readVfsFile(vfsDir: string, suffix: string): Promise<ArrayBuffer | null> {
  return ensureRModule().then(() => {
    const module = requireRModule();
    const rel = suffix.replace(/^\/+/, "");
    if (!rel || rel.includes("..")) {
      return null;
    }
    const path = `${vfsDir.replace(/\/$/, "")}/${rel}`;
    try {
      const data = module.FS.readFile(path, { encoding: "binary" });
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    } catch (err) {
      log("error", `[rWasmWorker] readVfsFile failed ${path}: ${formatRWasmError(err)}`);
      return null;
    }
  });
}

function readShinyResourcePathsFromR(): Record<string, string> {
  const module = requireRModule();
  evalRNow(`tryCatch({
  paths <- if (requireNamespace("shiny", quietly=TRUE)) as.list(shiny::resourcePaths()) else list()
  jsonlite::write_json(paths, "/resourcePaths.json", auto_unbox=TRUE)
}, error=function(e) {
  jsonlite::write_json(list(), "/resourcePaths.json", auto_unbox=TRUE)
})`);
  const text = module.FS.readFile("/resourcePaths.json", { encoding: "utf8" });
  try {
    module.FS.unlink("/resourcePaths.json");
  } catch {
    // ignore
  }
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, string>)
    : {};
}

function getShinyResourcePaths(): Promise<Record<string, string>> {
  return ensureRModule().then(() => {
    let result: Record<string, string> = {};
    return enqueueRTask(() => {
      result = readShinyResourcePathsFromR();
    }).then(() => result);
  });
}

function exposeRHost(port: MessagePort): void {
  const t = requireTransport();
  const api = createRHostApi(t.MSG.HTTP_REQUEST, {
    onHttpRequest: (req) =>
      ensureRModule()
        .then(() => enqueueHttpDelivery(req))
        .catch((err) => {
          logHttpDeliveryError(err);
          throw err;
        }),
    onStop: () => {
      void ensureRModule()
        .then(() => {
          void enqueueRTask(() => {
            requireTransport().pushInboundHostMessage({ type: t.MSG.STOP });
            evalRNow(WASM_STOP_EXPR);
          });
        })
        .catch((err) => {
          log("error", `[rWasmWorker] stop failed: ${formatRWasmError(err)}`);
        });
    },
    getResourcePaths: () => getShinyResourcePaths(),
    readVfsFile: (vfsDir, suffix) => readVfsFile(vfsDir, suffix),
    registerSwDelivery: (deliveryPort) => {
      connectSwDelivery(deliveryPort);
    },
  });
  Comlink.expose(api, port);
  rHostPortReady = true;
  console.info("[rWasmWorker] Comlink: exposing unified host API");
}

function connectSwDelivery(port: MessagePort): void {
  swDelivery = Comlink.wrap<SwDeliveryApi>(port);
  swDeliveryPortReady = true;
  console.info("[rWasmWorker] Comlink: connected to SW delivery API");
  maybeAnnounceComlinkReady();
}

function stopRunningApp(): Promise<void> {
  if (!rModule) {
    return Promise.resolve();
  }
  return enqueueRTask(() => {
    evalRNow(WASM_STOP_EXPR);
  }).catch((err) => {
    log("error", `[rWasmWorker] stopApp failed: ${formatRWasmError(err)}`);
  });
}

async function onMessage(event: MessageEvent): Promise<void> {
  const data = event.data;

  if (data?.type === RWASM.COMLINK_PORT && event.ports[0]) {
    const port = event.ports[0];
    port.start();
    rHostPortReady = false;
    swDeliveryPortReady = false;
    swDelivery = null;
    await ensureRModule();
    exposeRHost(port);
    return;
  }

  if (!data || typeof data.type !== "string") {
    return;
  }

  markActivity();

  switch (data.type) {
    case RWASM.WRITE_WEB_APP_FILES: {
      try {
        const module = await ensureRModule();
        const files = Array.isArray(data.files) ? (data.files as WebAppFile[]) : [];
        writeWebAppFilesToVfs(module, files);
        postToHost({ type: RWASM.EVAL_RESULT, id: data.id, ok: true });
      } catch (err) {
        postToHost({
          type: RWASM.EVAL_RESULT,
          id: data.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case RWASM.EVAL: {
      try {
        const module = await ensureRModule();
        await enqueueRTask(() => {
          evalR(module, String(data.code ?? ""));
        });
        if (data.id != null) {
          postToHost({ type: RWASM.EVAL_RESULT, id: data.id, ok: true });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (data.id != null) {
          postToHost({
            type: RWASM.EVAL_RESULT,
            id: data.id,
            ok: false,
            error: message,
          });
        } else {
          log("error", `[rWasmWorker] eval failed: ${message}`);
        }
      }
      break;
    }

    case RWASM.REMOUNT_R_HOME: {
      try {
        if (!rAssetBaseUrl) {
          throw new Error("R asset base URL is not set");
        }
        await remountRHome(requireRModule(), rAssetBaseUrl, config.hostPrefixDir);
        if (data.id != null) {
          postToHost({ type: RWASM.EVAL_RESULT, id: data.id, ok: true });
        }
      } catch (err) {
        log("error", `[rWasmWorker] remount R_HOME failed: ${formatRWasmError(err)}`);
        if (data.id != null) {
          postToHost({
            type: RWASM.EVAL_RESULT,
            id: data.id,
            ok: false,
            error: formatRWasmError(err),
          });
        }
      }
      break;
    }

    case RWASM.STOP_APP: {
      try {
        await stopRunningApp();
        if (data.id != null) {
          postToHost({ type: RWASM.STOPPED, id: data.id });
        }
      } catch (err) {
        log("error", `[rWasmWorker] stop failed: ${formatRWasmError(err)}`);
      }
      break;
    }

    case RWASM.GET_RESOURCE_PATHS: {
      try {
        const paths = await getShinyResourcePaths();
        postToHost({ type: RWASM.RESOURCE_PATHS, id: data.id, paths });
      } catch (err) {
        postToHost({
          type: RWASM.RESOURCE_PATHS,
          id: data.id,
          paths: {},
          error: formatRWasmError(err),
        });
      }
      break;
    }

    default:
      break;
  }
}

workerSelf.addEventListener("message", (event) => {
  void onMessage(event);
});

void ensureRModule()
  .then(() => postToHost({ type: RWASM.READY }))
  .catch((err) => {
    postToHost({
      type: RWASM.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
  });
