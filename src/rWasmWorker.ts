import * as Comlink from "comlink";

import { resolveLucentConfig } from "./config";
import {
  evalR,
  initRModule,
  setEvalRPostFlush,
  writeWebAppToVfs,
  type RModule,
} from "./rWasmBootstrap";
import { RWASM } from "./rwasm-constants";
import { loadTransport, type ChannelMessageLike, type HttpuvTransport, type OutboundMessage } from "./transport";
import { createRHostApi, type HostInboundMessage, type SwDeliveryApi } from "./wiring";

const workerSelf = self as unknown as DedicatedWorkerGlobalScope;
const config = resolveLucentConfig();

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

// Suspend Shiny's serviceNonBlocking loop without patching the installed package:
// bump serviceGeneration so in-flight serviceLoop callbacks exit (see
// shiny/tests/testthat/test-non-blocking.R). Resume via serviceNonBlocking().
const WASM_SUSPEND_SHINY_LOOP = `tryCatch({
  if (requireNamespace("shiny", quietly=TRUE) && shiny::isRunning()) {
    shiny:::.globals$serviceGeneration <- shiny:::.globals$serviceGeneration + 1L
  }
}, error=function(e) NULL)`;

const WASM_RESUME_SHINY_LOOP = `tryCatch({
  if (requireNamespace("shiny", quietly=TRUE) && shiny::isRunning()) {
    h <- shiny:::.globals$runningHandle
    if (!is.null(h)) {
      shiny:::serviceNonBlocking(h, shiny:::.globals$serviceGeneration)
    }
  }
}, error=function(e) NULL)`;

/** Background pump when the R task queue is idle. */
const WASM_SINGLE_SERVICE_TICK = `tryCatch({
  has_srv <- requireNamespace("shiny", quietly=TRUE) &&
    !is.null(shiny::getShinyOption("server", default=NULL))
  if (has_srv) {
    shiny::serviceApp(NA)
  } else if (!later::loop_empty()) {
    later::run_now(0, all=FALSE)
  }
}, error=function(e) NULL)`;

/** Host-controlled service tick while Shiny's serviceLoop is suspended. */
const WASM_HTTP_DRAIN_TICK = WASM_SINGLE_SERVICE_TICK;

/** Service rounds after push idle wait (promise resolution only). */
const HTTP_PUSH_DRAIN_ROUNDS = 64;

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

const R_LATER_PUMP_MS = 16;
let rLaterPumpActive = false;

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
  setTimeout(drainRTaskQueue, 0);
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
  message("[httpuv] push failed: ", conditionMessage(e))
  stop(conditionMessage(e))
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
    setTimeout(() => {
      void enqueueRTask(() => {
        evalRNow(WASM_HTTP_DRAIN_TICK);
      })
        .then(() => drainAfterHttpPush(roundsLeft - 1, uuid, state))
        .then(resolve);
    }, HTTP_DRAIN_YIELD_MS);
  });
}

function scheduleRLaterPump(): void {
  if (rLaterPumpActive) {
    return;
  }
  rLaterPumpActive = true;
  setTimeout(() => {
    rLaterPumpActive = false;
    if (!rModule) {
      return;
    }
    if (!rLocked && rTaskQueue.length === 0 && !httpDeliveryActive) {
      void enqueueRTask(() => {
        evalRNow(WASM_SINGLE_SERVICE_TICK);
      }).catch((err) => {
        console.warn("[rWasmWorker] later pump failed:", formatRWasmError(err));
      });
    }
    scheduleRLaterPump();
  }, R_LATER_PUMP_MS);
}

function ensureRLaterPump(): void {
  scheduleRLaterPump();
  dbg("later-pump", { intervalMs: R_LATER_PUMP_MS });
}

function logHttpDeliveryError(err: unknown): void {
  console.error("[rWasmWorker] deliverHttpRequest failed:", formatRWasmError(err), err);
}

/**
 * Queue one HTTP request. Requests run strictly one-at-a-time; Shiny's
 * service loop is suspended once for the whole batch.
 */
function enqueueHttpDelivery(req: HostInboundMessage): Promise<void> {
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
  t.setShinyPrefix(t.resolveShinyPrefix(import.meta.url));
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
  const module = await initRModule({
    assetBaseUrl,
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

  switch (data.type) {
    case RWASM.INIT: {
      try {
        await ensureRModule();
        postToHost({ type: RWASM.READY });
      } catch (err) {
        postToHost({
          type: RWASM.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case RWASM.WRITE_WEB_APP: {
      try {
        const module = await ensureRModule();
        writeWebAppToVfs(module, String(data.source ?? ""));
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
