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
import { createHttpDelivery, type HttpDelivery } from "./rWasmHttpDelivery";
import { createLaterPump } from "./rWasmPump";
import { createRTaskQueue, SHINY_HOST } from "./rWasmTasks";
import { RWASM } from "./rwasm-constants";
import {
  loadTransport,
  type ChannelMessageLike,
  type HttpuvTransport,
  type OutboundMessage,
} from "./transport";
import { createRHostApi, type SwDeliveryApi } from "./wiring";

const workerSelf = self as unknown as DedicatedWorkerGlobalScope;
const config = resolveLucentConfig();

let rAssetBaseUrl: string | null = null;
let transport: HttpuvTransport | null = null;
let rModule: RModule | null = null;
let rModulePromise: Promise<RModule> | null = null;
let swDelivery: Comlink.Remote<SwDeliveryApi> | null = null;
let rHostPortReady = false;
let swDeliveryPortReady = false;

const tasks = createRTaskQueue({
  getModule: () => rModule,
  getTransport: () => transport,
});

const httpRef: { current: HttpDelivery | null } = { current: null };

const pump = createLaterPump({
  tasks,
  getModule: () => rModule,
  isHttpDeliveryActive: () => httpRef.current?.isHttpDeliveryActive() ?? false,
  hasHttpWork: () => httpRef.current?.hasHttpWork() ?? false,
  formatError: formatRWasmError,
  dbg,
});

const http = createHttpDelivery({
  tasks,
  getModule: () => rModule,
  requireTransport,
  markActivity: () => pump.markActivity(),
  dbg,
  formatError: formatRWasmError,
  logError: logHttpDeliveryError,
});
httpRef.current = http;

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

function replyOk(id: unknown): void {
  if (id == null) {
    return;
  }
  postToHost({ type: RWASM.EVAL_RESULT, id, ok: true });
}

function replyErr(id: unknown, err: unknown): void {
  if (id == null) {
    return;
  }
  postToHost({
    type: RWASM.EVAL_RESULT,
    id,
    ok: false,
    error: formatRWasmError(err),
  });
}

function logHttpDeliveryError(err: unknown, url?: string): void {
  const where = url ? ` ${url}` : "";
  console.error(`[rWasmWorker] deliverHttpRequest failed:${where}`, formatRWasmError(err), err);
}

function deliverToServiceWorker(outbound: OutboundMessage, transfer: Transferable[] = []): void {
  const t = requireTransport();
  if (!swDelivery) {
    console.warn("[rWasmWorker] Service worker delivery API not connected");
    return;
  }
  pump.markActivity();

  if (outbound.type === t.MSG.HTTP_RESPONSE) {
    dbg("comlink-deliver-http", { uuid: outbound.uuid, status: outbound.status });
    http.noteHttpResponse(outbound.uuid);
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
  tasks.evalRNow(`tryCatch({
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
  http.setIdleMaxMs(transport.REQUEST_TIMEOUT_MS);
  const assetBaseUrl = new URL(config.rRuntimeBaseUrl, self.location.href).href;
  rAssetBaseUrl = assetBaseUrl;
  const module = await initRModule({
    assetBaseUrl,
    hostPrefixDir: config.hostPrefixDir,
    print: (text) => log("log", text),
    printErr: (text) => log("error", text),
  });
  rModule = module;
  installBridge(transport);
  pump.ensureRLaterPump();
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
  tasks.evalRNow(`tryCatch({
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
    return tasks
      .enqueueRTask(() => {
        result = readShinyResourcePathsFromR();
      })
      .then(() => result);
  });
}

function exposeRHost(port: MessagePort): void {
  const t = requireTransport();
  const api = createRHostApi(t.MSG.HTTP_REQUEST, {
    onHttpRequest: (req) =>
      ensureRModule()
        .then(() => http.enqueueHttpDelivery(req))
        .catch((err) => {
          logHttpDeliveryError(err);
          throw err;
        }),
    onStop: () => {
      void ensureRModule()
        .then(() => {
          void tasks.enqueueRTask(() => {
            requireTransport().pushInboundHostMessage({ type: t.MSG.STOP });
            tasks.evalRNow(SHINY_HOST.stop);
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
  return tasks.enqueueRTask(() => {
    tasks.evalRNow(SHINY_HOST.stop);
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

  pump.markActivity();

  switch (data.type) {
    case RWASM.WRITE_WEB_APP_FILES: {
      try {
        const module = await ensureRModule();
        const files = Array.isArray(data.files) ? (data.files as WebAppFile[]) : [];
        writeWebAppFilesToVfs(module, files);
        replyOk(data.id);
      } catch (err) {
        replyErr(data.id, err);
      }
      break;
    }

    case RWASM.EVAL: {
      try {
        const module = await ensureRModule();
        await tasks.enqueueRTask(() => {
          evalR(module, String(data.code ?? ""));
        });
        replyOk(data.id);
      } catch (err) {
        if (data.id != null) {
          replyErr(data.id, err);
        } else {
          log("error", `[rWasmWorker] eval failed: ${formatRWasmError(err)}`);
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
        replyOk(data.id);
      } catch (err) {
        log("error", `[rWasmWorker] remount R_HOME failed: ${formatRWasmError(err)}`);
        replyErr(data.id, err);
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
