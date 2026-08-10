import { CHANNEL, HTTPUV_OPTIONS, MSG, WS_FRAME } from "./constants";
import { httpuvDebugLog } from "./debug";
import {
  getShinyPrefix,
  normalizeSessionHandle,
  parseSessionAction,
  shinyAppUrl,
} from "./prefix";
import type { SessionAction } from "./prefix";
import type {
  ChannelMessage,
  HeaderMap,
  HostInboundMessage,
  HttpRequestInput,
  HttpuvChannel,
  HttpuvModule,
  InvokeROption,
  OutboundDeliver,
} from "./types";

let invokeROption: InvokeROption | null = null;

let pushToR: ((msg: ChannelMessage) => void) | null = null;

function decodeBase64Body(data: unknown): ArrayBuffer {
  const text = String(data ?? "");
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function encodeResponseBody(body: unknown): string | ArrayBuffer | null {
  if (body == null) {
    return null;
  }
  if (
    typeof body === "object" &&
    !Array.isArray(body) &&
    (body as { httpuvRaw?: string }).httpuvRaw === "base64"
  ) {
    return decodeBase64Body((body as { data?: unknown }).data);
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return body;
  }
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(body)) {
    return new Uint8Array(body).buffer;
  }
  return String(body);
}

function normalizeHeaders(headers: unknown): HeaderMap {
  if (!headers || typeof headers !== "object") {
    return {};
  }
  const out: HeaderMap = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (value != null) {
      out[key] = String(value);
    }
  }
  return out;
}

function shinyPathInfo(pathname: string): string {
  const shinyPrefix = getShinyPrefix();
  if (!pathname.startsWith(shinyPrefix)) {
    return pathname || "/";
  }
  const rest = pathname.slice(shinyPrefix.length).replace(/^\/+/, "");
  return rest ? `/${rest}` : "/";
}

/** Build a rook-like request env object for httpuv handlers. */
export function buildReq(msg: HttpRequestInput): Record<string, unknown> {
  const url = new URL(msg.url);
  const pathInfo = shinyPathInfo(url.pathname);
  const queryString = url.search.length > 1 ? url.search.slice(1) : "";
  const shinyPrefix = getShinyPrefix();

  const req: Record<string, unknown> = {
    UUID: msg.uuid,
    REQUEST_METHOD: msg.method,
    SCRIPT_NAME: shinyPrefix.replace(/\/$/, ""),
    PATH_INFO: pathInfo,
    QUERY_STRING: queryString,
    "rook.version": "1.1-0",
    "rook.url_scheme": url.protocol === "https:" ? "https" : "http",
    SERVER_NAME: url.hostname,
    SERVER_PORT: url.port || (url.protocol === "https:" ? "443" : "80"),
    REMOTE_ADDR: "127.0.0.1",
    REMOTE_PORT: "0",
    HEADERS: { ...(msg.headers ?? {}) },
  };

  for (const [key, value] of Object.entries(msg.headers ?? {})) {
    req[`HTTP_${key.toUpperCase().replace(/-/g, "_")}`] = value;
  }

  if (msg.body) {
    req.body = msg.body;
    req.CONTENT_LENGTH = String(msg.body.byteLength);
  }

  return req;
}

/** Absolute pathname for shiny-socket.js (served next to httpuv-web.js). */
export function shinySocketScriptUrl(): string {
  return new URL("./shiny-socket.js", import.meta.url).pathname;
}

/** Inject the virtual Shiny socket bootstrap into an HTML document. */
export function injectShinySocketBootstrap(html: string): string {
  const prefix = getShinyPrefix();
  const baseTag = html.includes("<base") ? "" : `<base href="${prefix}">`;
  const tag = `<script type="module" src="${shinySocketScriptUrl()}"></script>`;
  const injection = [baseTag, tag].filter(Boolean).join("\n  ");
  if (html.includes("<head")) {
    return html.replace(/<head([^>]*)>/, `<head$1>\n  ${injection}`);
  }
  if (html.includes("<body")) {
    return html.replace(/<body([^>]*)>/, `<body$1>\n  ${tag}`);
  }
  return `${tag}\n${html}`;
}

function bodyToText(body: unknown): string | null {
  if (body == null) {
    return null;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }
  if (Array.isArray(body)) {
    return new TextDecoder().decode(new Uint8Array(body));
  }
  return String(body);
}

function maybeInjectShinySocketBootstrap(
  body: unknown,
  headers: HeaderMap,
): string | ArrayBuffer | null {
  const contentType =
    Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "";
  if (!contentType.includes("text/html")) {
    return encodeResponseBody(body);
  }
  const html = bodyToText(body);
  if (!html) {
    return encodeResponseBody(body);
  }
  return injectShinySocketBootstrap(html);
}

function sessionMessageFromBody(
  body: ArrayBuffer | null | undefined,
): { binary: boolean; message: string | ArrayBuffer } {
  if (!body || body.byteLength === 0) {
    return { binary: false, message: "" };
  }
  const bytes = new Uint8Array(body);
  const isText = bytes.every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126));
  if (isText) {
    return { binary: false, message: new TextDecoder().decode(body) };
  }
  return { binary: true, message: body };
}

function handleSessionHttp(msg: HostInboundMessage, session: SessionAction): void {
  switch (session.action) {
    case "open": {
      const handle = normalizeSessionHandle(crypto.randomUUID());
      const req = buildReq(msg as HttpRequestInput);
      pushInboundChannelMessage({ type: CHANNEL.WS_OPEN, handle, req });
      sendTcpResponse(
        msg.uuid ?? "",
        200,
        { "Content-Type": "application/json" },
        JSON.stringify({ handle }),
      );
      break;
    }

    case "send": {
      if (!session.handle) {
        sendTcpResponse(msg.uuid ?? "", 400, { "Content-Type": "text/plain" }, "missing handle");
        return;
      }
      const { binary, message } = sessionMessageFromBody(msg.body);
      pushInboundChannelMessage({
        type: CHANNEL.WS_MESSAGE,
        handle: normalizeSessionHandle(session.handle),
        binary,
        message,
      });
      sendTcpResponse(msg.uuid ?? "", 204, {}, null);
      break;
    }

    case "close": {
      if (!session.handle) {
        sendTcpResponse(msg.uuid ?? "", 400, { "Content-Type": "text/plain" }, "missing handle");
        return;
      }
      pushInboundChannelMessage({
        type: CHANNEL.WS_CLOSE,
        handle: normalizeSessionHandle(session.handle),
      });
      sendTcpResponse(msg.uuid ?? "", 204, {}, null);
      break;
    }

    default:
      sendTcpResponse(
        msg.uuid ?? "",
        404,
        { "Content-Type": "text/plain" },
        "unknown session action",
      );
  }
}

function sendTcpResponse(
  uuid: string,
  status: number,
  headers: HeaderMap,
  body: unknown,
): void {
  getChannel().write({
    type: CHANNEL.TCP_RESPONSE,
    uuid,
    data: {
      status,
      headers,
      body,
    },
  });
}

function getServiceWorkerController(): ServiceWorker | null {
  return navigator.serviceWorker.controller;
}

function serializeBodyForChannel(body: ArrayBuffer | null | undefined): number[] | null {
  if (!body) {
    return null;
  }
  return Array.from(new Uint8Array(body));
}

function formatOutboundForHost(msg: ChannelMessage, deliver: OutboundDeliver): void {
  if (msg.type === CHANNEL.TCP_RESPONSE) {
    const headers = normalizeHeaders(msg.data?.headers);
    let body: string | ArrayBuffer | null;
    try {
      body = maybeInjectShinySocketBootstrap(msg.data?.body, headers);
    } catch (err) {
      console.warn("[httpuv-bridge] shiny socket bootstrap injection failed", err);
      body = encodeResponseBody(msg.data?.body);
    }
    const transfer = body instanceof ArrayBuffer ? [body] : [];
    deliver(
      {
        type: MSG.HTTP_RESPONSE,
        uuid: msg.uuid,
        status: msg.data?.status ?? 500,
        headers,
        body,
      },
      transfer,
    );
    return;
  }

  const body = encodeResponseBody(msg.data?.message);
  const transfer = body instanceof ArrayBuffer ? [body] : [];

  if (msg.type === CHANNEL.WS_RESPONSE) {
    deliver(
      {
        type: MSG.WS_PUSH,
        handle: normalizeSessionHandle(msg.data?.handle),
        binary: msg.data?.binary ?? false,
        wsType: msg.data?.type ?? WS_FRAME.SEND,
        message: body,
      },
      transfer,
    );
  }
}

async function postToServiceWorker(msg: ChannelMessage): Promise<void> {
  const controller = getServiceWorkerController();
  formatOutboundForHost(msg, (outbound, transfer = []) => {
    if (msg.type === CHANNEL.TCP_RESPONSE) {
      if (controller) {
        controller.postMessage(outbound, transfer);
        return;
      }
      void fetch(shinyAppUrl("__host__/push"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(outbound),
      });
      return;
    }

    if (msg.type === CHANNEL.WS_RESPONSE) {
      if (controller) {
        controller.postMessage(outbound, transfer);
        return;
      }
      const outboundMsg = outbound as { message?: unknown };
      void fetch(shinyAppUrl("__host__/push"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...outbound,
          message:
            typeof outboundMsg.message === "string" ? outboundMsg.message : undefined,
        }),
      });
    }
  });
}

let postOutbound: OutboundDeliver | null = null;

const deferredOutbound: ChannelMessage[] = [];

/**
 * Deliver responses queued while evalR is active (Comlink must not run inside WASM eval).
 */
export function flushDeferredOutbound(): void {
  if (deferredOutbound.length === 0) {
    return;
  }
  const batch = deferredOutbound.splice(0, deferredOutbound.length);
  for (const msg of batch) {
    postOutboundSync(msg);
  }
}

function postOutboundMaybeDefer(msg: ChannelMessage): void {
  const depth = globalThis.Module?._rWasmEvalDepth ?? 0;
  if (depth > 0) {
    deferredOutbound.push(msg);
    if (msg.type === CHANNEL.TCP_RESPONSE) {
      httpuvDebugLog("channel-tcp-response-deferred", {
        uuid: msg.uuid,
        status: msg.data?.status,
        depth,
      });
    }
    return;
  }
  if (msg.type === CHANNEL.TCP_RESPONSE) {
    httpuvDebugLog("channel-tcp-response", {
      uuid: msg.uuid,
      status: msg.data?.status,
    });
  }
  postOutboundSync(msg);
}

function postOutboundSync(msg: ChannelMessage): void {
  if (postOutbound) {
    formatOutboundForHost(msg, (outbound, transfer = []) => {
      postOutbound?.(outbound, transfer);
    });
    return;
  }
  void postToServiceWorker(msg);
}

function createChannel(): HttpuvChannel {
  const inbox: ChannelMessage[] = [];

  return {
    inbox,

    hasMessage() {
      return inbox.length > 0;
    },

    read() {
      return inbox.shift() ?? { type: CHANNEL.STDIN };
    },

    write(msg: ChannelMessage) {
      if (msg.type === CHANNEL.TCP_RESPONSE || msg.type === CHANNEL.WS_RESPONSE) {
        postOutboundMaybeDefer(msg);
        return;
      }
      console.warn(
        "[httpuv-bridge] inbound channel.write is deprecated; use pushInboundChannelMessage",
        msg.type,
      );
      pushInboundChannelMessage(msg);
    },
  };
}

export function dispatch(msg: ChannelMessage): void {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
    return;
  }

  switch (msg.type) {
    case CHANNEL.HTTP_REQUEST: {
      const req = buildReq(msg as unknown as HttpRequestInput);
      const handled = invokeROption?.(HTTPUV_OPTIONS.ON_REQUEST, req) ?? false;
      if (!handled) {
        sendTcpResponse(
          msg.uuid ?? "",
          503,
          { "Content-Type": "text/plain" },
          "httpuv: no R handler registered",
        );
      }
      break;
    }

    case CHANNEL.WS_OPEN: {
      const handled =
        invokeROption?.(HTTPUV_OPTIONS.ON_WS_OPEN, msg.handle, msg.req) ?? false;
      if (!handled) {
        httpuvDebugLog("bridge-ws-open-no-handler", msg.handle);
      }
      break;
    }

    case CHANNEL.WS_MESSAGE: {
      const handled =
        invokeROption?.(
          HTTPUV_OPTIONS.ON_WS_MESSAGE,
          msg.handle,
          msg.binary,
          msg.message,
        ) ?? false;
      if (!handled) {
        httpuvDebugLog("bridge-ws-message-no-handler", msg.handle);
        getChannel().write({
          type: CHANNEL.WS_RESPONSE,
          data: {
            handle: msg.handle,
            binary: msg.binary,
            type: WS_FRAME.SEND,
            message: msg.message,
          },
        });
      }
      break;
    }

    case CHANNEL.WS_CLOSE: {
      invokeROption?.(HTTPUV_OPTIONS.ON_WS_CLOSE, msg.handle);
      break;
    }

    default:
      console.warn("[httpuv-bridge] unhandled channel message", msg.type);
  }
}

/** Drain inbound channel messages until empty or only stdin placeholders remain. */
export function drainInboundChannel(): void {
  const channel = getChannel();
  while (channel.hasMessage()) {
    const msg = channel.read();
    if (msg.type === CHANNEL.STDIN) {
      continue;
    }
    dispatch(msg);
  }
}

function getChannel(): HttpuvChannel {
  const httpuv = ensureModuleHttpuv();
  if (!httpuv.channel) {
    httpuv.channel = createChannel();
  }
  return httpuv.channel;
}

function ensureModuleHttpuv(): HttpuvModule {
  globalThis.Module = globalThis.Module ?? {};
  globalThis.Module.httpuv = globalThis.Module.httpuv ?? {};
  return globalThis.Module.httpuv;
}

/** Push a channel message into R immediately (worker push path). */
export function pushInboundChannelMessage(msg: ChannelMessage): boolean {
  if (!pushToR) {
    console.warn("[httpuv-bridge] pushToR not configured");
    return false;
  }
  pushToR(msg);
  return true;
}

/** Push an inbound host message from the service worker into R. */
export function pushInboundHostMessage(msg: HostInboundMessage): void {
  if (!msg || typeof msg !== "object") {
    return;
  }

  switch (msg.type) {
    case MSG.HTTP_REQUEST: {
      const session = parseSessionAction(msg.url ?? "", getShinyPrefix());
      if (session && session.action !== "recv") {
        httpuvDebugLog("bridge-inbound-session", {
          uuid: msg.uuid,
          action: session.action,
          handle: session.handle,
        });
        handleSessionHttp(msg, session);
        break;
      }

      httpuvDebugLog("bridge-push-http", {
        uuid: msg.uuid,
        method: msg.method,
        url: msg.url,
      });
      pushInboundChannelMessage({
        type: CHANNEL.HTTP_REQUEST,
        uuid: msg.uuid,
        method: msg.method,
        url: msg.url,
        headers: msg.headers ?? {},
        body: serializeBodyForChannel(msg.body),
        clientId: msg.clientId,
      });
      break;
    }

    case MSG.STOP:
      break;

    default:
      break;
  }
}

/** Handle an inbound message from the service worker (or a host proxy). */
export function handleInboundHostMessage(msg: HostInboundMessage): void {
  pushInboundHostMessage(msg);
}

function installServiceWorkerListener(): void {
  navigator.serviceWorker.addEventListener("message", (event) => {
    handleInboundHostMessage(event.data as HostInboundMessage);
  });
}

export interface HttpuvBridgeOptions {
  /** Deliver HTTP/WS responses to the host (main page -> service worker). */
  postOutbound?: OutboundDeliver;
  /** Listen for service worker messages in this context (false in the R worker). */
  installSwListener?: boolean;
  /** Push inbound HTTP/WebSocket channel messages into R (R worker only). */
  pushToR?: (msg: ChannelMessage) => void;
  /** Shiny host mode: immediate wake (NEED_SERVICE). */
  requestHostService?: () => void;
  /** Shiny host mode: delayed wake (SCHEDULE_DELAY). */
  scheduleHostDelay?: (delayMs: number) => void;
}

/**
 * Install Module.httpuv (channel + dispatch) and optionally wire the service
 * worker listener. Call before WASM R starts.
 */
export function installHttpuvBridge(options: HttpuvBridgeOptions = {}): HttpuvModule {
  if (options.postOutbound) {
    postOutbound = options.postOutbound;
  }
  if (options.pushToR) {
    pushToR = options.pushToR;
  }

  const httpuv = ensureModuleHttpuv();

  if (!httpuv.channel) {
    httpuv.channel = createChannel();
  }

  httpuv.dispatch = dispatch;
  httpuv.drainInboundChannel = drainInboundChannel;
  httpuv.pushInboundChannelMessage = pushInboundChannelMessage;
  httpuv.pushInboundHostMessage = pushInboundHostMessage;
  httpuv.buildReq = buildReq;
  httpuv.injectShinySocketBootstrap = injectShinySocketBootstrap;
  httpuv.shinySocketScriptUrl = shinySocketScriptUrl;
  httpuv.shinyPrefix = getShinyPrefix();

  if (options.requestHostService) {
    httpuv.requestHostService = options.requestHostService;
  }
  if (options.scheduleHostDelay) {
    httpuv.scheduleHostDelay = options.scheduleHostDelay;
  }

  /** Push a message to a virtual socket recv waiter (used by R via channel.write). */
  httpuv.pushWsMessage = (handle, message, opts = {}) => {
    getChannel().write({
      type: CHANNEL.WS_RESPONSE,
      data: {
        handle,
        binary: opts.binary ?? false,
        type: opts.wsType ?? WS_FRAME.SEND,
        message,
      },
    });
  };

  /** Called from R (via emscripten) once httpuv registers option handlers. */
  httpuv.bindInvokeROption = (fn: InvokeROption) => {
    invokeROption = fn;
  };

  const installSwListener = options.installSwListener ?? true;
  if (installSwListener && !httpuv._swListenerInstalled) {
    installServiceWorkerListener();
    httpuv._swListenerInstalled = true;
  }

  httpuvDebugLog("bridge-installed");
  return httpuv;
}

export function setInvokeROption(fn: InvokeROption | null): void {
  invokeROption = fn;
}

export function setPushToR(fn: ((msg: ChannelMessage) => void) | null): void {
  pushToR = fn;
}
