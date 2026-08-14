/// <reference lib="webworker" />
import type { Remote } from "comlink";
import {
  COMLINK,
  MSG,
  REQUEST_TIMEOUT_MS,
  WASM_R_HOME,
  WARMUP_REQUEST_HEADER,
  WS_FRAME,
} from "./constants";
import { Comlink, createSwDeliveryApi } from "./comlink";
import type { RHostApi } from "./comlink";
import { httpuvDebugLog } from "./debug";
import {
  isHostPushUrl,
  normalizeSessionHandle,
  parseSessionAction,
  resolveSessionPrefix,
  resolveShinyPrefix,
} from "./prefix";
import { maybePatchAppDocumentResponse } from "./htmlwidget-deps-patch";
import type { HeaderMap, PendingResponse } from "./types";

// `self` is typed as Window because the DOM lib is enabled for the other
// entries; cast it to the service-worker global for this bundle.
const swSelf = self as unknown as ServiceWorkerGlobalScope;

/**
 * Resolve the initial mount prefix without assuming the SW script location.
 * The bundle may live under /lucent/dist/ or as a root alias /httpuv-sw.js;
 * deriving the Shiny prefix from import.meta.url is wrong. Prefer an explicit
 * `?shinyPrefix=` on the registration URL; otherwise default to the origin
 * root, giving `/shiny/`. The host also confirms this via REGISTER_HOST.
 */
function initialShinyPrefix(): string {
  try {
    const own = new URL(swSelf.location.href);
    const declared = own.searchParams.get("shinyPrefix");
    if (declared) {
      return declared.endsWith("/") ? declared : `${declared}/`;
    }
  } catch {
    // fall through to origin-root default
  }
  return resolveShinyPrefix(new URL("/", swSelf.location.href).href);
}

const SHINY_PREFIX = initialShinyPrefix();
const SESSION_PREFIX = resolveSessionPrefix(new URL("/", swSelf.location.href).href);
void SESSION_PREFIX;

/** Host-announced prefix (defaults to the origin-root mount; updated via REGISTER_HOST). */
let shinyAppPrefix = SHINY_PREFIX;

let hostClientId: string | null = null;

let rwasmHost: Remote<RHostApi> | null = null;

interface RwasmHostReady {
  promise: Promise<Remote<RHostApi>>;
  resolve: (host: Remote<RHostApi>) => void;
  reject: (err: Error) => void;
}

function createRwasmHostReady(): RwasmHostReady {
  let resolve!: (host: Remote<RHostApi>) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<Remote<RHostApi>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Pending waiters until Comlink connects or the handshake is reset/fails. */
let rwasmHostReady: RwasmHostReady = createRwasmHostReady();

interface WsPushMsg {
  wsType?: string;
  binary?: boolean;
  message?: unknown;
}

interface HttpWaiter {
  resolve: (resp: PendingResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  url: string;
  method: string;
}

interface HostOutbound {
  type: string;
  uuid?: string;
  status?: number;
  headers?: HeaderMap;
  body?: ArrayBuffer | Uint8Array | string | null;
  handle?: string;
  binary?: boolean;
  wsType?: string;
  message?: unknown;
}

async function connectSwToWorker(port: MessagePort): Promise<void> {
  const workerHost = Comlink.wrap<RHostApi>(port);
  const deliveryChannel = new MessageChannel();
  Comlink.expose(
    createSwDeliveryApi((msg) => handleHostOutboundMessage(msg as HostOutbound)),
    deliveryChannel.port1,
  );
  try {
    await workerHost.registerSwDelivery(
      Comlink.transfer(deliveryChannel.port2, [deliveryChannel.port2]),
    );
    rwasmHost = workerHost;
    markRwasmHostReady();
    httpuvDebugLog("sw-comlink-connected");
  } catch (err) {
    console.error("[httpuv-sw] Comlink unified setup failed", err);
    const message = err instanceof Error ? err.message : String(err);
    resetRwasmHostWaiter(new Error(`R worker Comlink setup failed: ${message}`));
  }
}

function markRwasmHostReady(): void {
  if (!rwasmHost) {
    return;
  }
  rwasmHostReady.resolve(rwasmHost);
}

/**
 * Hard reset: drop the host and reject anyone waiting (activate / STOP / fatal
 * Comlink failure). Callers that need a reconnect should use
 * {@link rollRwasmHostWaiter} instead so in-flight fetches keep waiting.
 */
function resetRwasmHostWaiter(reason?: Error): void {
  const previous = rwasmHostReady;
  rwasmHost = null;
  rwasmHostReady = createRwasmHostReady();
  previous.reject(reason ?? new Error("R worker Comlink not ready"));
}

/**
 * Soft reset for PORT_HANDOFF: clear the live host and open a new waiter, but
 * forward settlement to the previous promise so warmup/fetch waiters are not
 * rejected mid-handshake (that produced instant HTTP 503 "not ready").
 */
function rollRwasmHostWaiter(): void {
  const previous = rwasmHostReady;
  rwasmHost = null;
  rwasmHostReady = createRwasmHostReady();
  void rwasmHostReady.promise.then(
    (host) => {
      previous.resolve(host);
    },
    (err: unknown) => {
      previous.reject(err instanceof Error ? err : new Error(String(err)));
    },
  );
}

async function waitForRwasmHost(): Promise<Remote<RHostApi>> {
  // Retry across soft handoffs: a PORT_HANDOFF may replace rwasmHostReady while
  // we are awaiting; permanent rejects (STOP / setup failure) still propagate.
  for (;;) {
    if (rwasmHost) {
      return rwasmHost;
    }
    const ready = rwasmHostReady;
    try {
      return await ready.promise;
    } catch (err) {
      if (rwasmHost) {
        return rwasmHost;
      }
      if (rwasmHostReady !== ready) {
        continue;
      }
      throw err;
    }
  }
}

/** Ask the Lucent host page to re-handshake Comlink MessagePorts. */
async function requestComlinkFromHost(): Promise<void> {
  // Broadcast to every window client. After an idle SW restart hostClientId is
  // gone, and Chromium often lists the focused /shiny/ iframe first — posting
  // only to clients[0] never reaches Lucent. The iframe ignores this message.
  const clients = await swSelf.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  httpuvDebugLog("sw-request-comlink", {
    clients: clients.length,
    hostClientId,
    urls: clients.map((c) => c.url),
  });
  for (const client of clients) {
    client.postMessage({ type: MSG.REQUEST_COMLINK });
  }
}

const pendingHttp = new Map<string, HttpWaiter>();

/** Per-session MessagePort for SW → iframe WS push delivery. */
const sessionPorts = new Map<string, MessagePort>();

/** Iframe clientId that owns each session (for REQUEST_SESSION_PORT after SW idle). */
const sessionClientIds = new Map<string, string>();

/** Frames that arrived before REGISTER_SESSION (mirrors old recv queue). */
const queuedWsPush = new Map<string, WsPushMsg[]>();

/** Avoid spamming the client with re-register requests while one is in flight. */
const sessionPortReregisterPending = new Set<string>();

/** Cached GET /shiny/ document so warmup and iframe do not each trigger a full R render. */
let cachedAppDocument: PendingResponse | null = null;

/** addResourcePath prefix -> VFS directory (e.g. shiny-plots -> /tmp/shiny-plots). */
let shinyResourcePaths = new Map<string, string>();

function isAppDocumentRequest(urlString: string): boolean {
  const url = new URL(urlString);
  if (!url.pathname.startsWith(shinyAppPrefix)) {
    return false;
  }
  const rest = url.pathname.slice(shinyAppPrefix.length).replace(/\/$/, "");
  return rest === "" || rest === "index.html";
}

function pathUnderShinyPrefix(pathname: string): boolean {
  return pathname.startsWith(shinyAppPrefix) || pathname.startsWith(SHINY_PREFIX);
}

function clonePendingResponse(resp: PendingResponse): PendingResponse {
  let body = resp.body;
  if (body instanceof ArrayBuffer) {
    body = body.slice(0);
  } else if (body instanceof Uint8Array) {
    body = body.slice();
  }
  return {
    status: resp.status,
    headers: { ...(resp.headers ?? {}) },
    body,
  };
}

function clearCachedAppDocument(): void {
  cachedAppDocument = null;
}

function clearShinyResourcePaths(): void {
  shinyResourcePaths = new Map();
}

function setShinyResourcePaths(paths: Record<string, string>): void {
  shinyResourcePaths = new Map();
  for (const [prefix, dir] of Object.entries(paths ?? {})) {
    if (prefix && dir) {
      shinyResourcePaths.set(prefix, dir);
    }
  }
  if (shinyResourcePaths.size > 0) {
    httpuvDebugLog("sw-resource-paths", {
      count: shinyResourcePaths.size,
      keys: [...shinyResourcePaths.keys()],
    });
  }
}

function updateShinyResourcePath(prefix: string, dir: string | undefined): void {
  if (!prefix) {
    return;
  }
  if (!dir) {
    shinyResourcePaths.delete(prefix);
  } else {
    shinyResourcePaths.set(prefix, dir);
  }
  httpuvDebugLog("sw-resource-path-update", {
    prefix,
    dir: dir || null,
    count: shinyResourcePaths.size,
  });
}

function mimeForAssetSuffix(suffix: string): string {
  if (suffix.endsWith(".js") || suffix.endsWith(".mjs")) {
    return "application/javascript";
  }
  if (suffix.endsWith(".css")) {
    return "text/css";
  }
  if (suffix.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (suffix.endsWith(".png")) {
    return "image/png";
  }
  if (suffix.endsWith(".woff2")) {
    return "font/woff2";
  }
  if (suffix.endsWith(".woff")) {
    return "font/woff";
  }
  return "application/octet-stream";
}

/** Pathname relative to the SW registration scope (`/` or `/repo/` on Pages). */
function pathnameRelativeToScope(pathname: string): string {
  const scopeUrl = swSelf.registration?.scope;
  if (!scopeUrl) {
    return pathname;
  }
  let scopePath = new URL(scopeUrl).pathname;
  if (!scopePath.endsWith("/")) {
    scopePath += "/";
  }
  if (scopePath !== "/" && pathname.startsWith(scopePath)) {
    return `/${pathname.slice(scopePath.length)}`;
  }
  return pathname;
}

/**
 * Map a request pathname to an absolute VFS path under `/lib/R/`.
 * Must be the R_HOME mount (`/lib/R/...` or `/repo/lib/R/...`), not a substring
 * of `/runtime/lib/R/...` (Rmain SIDE_MODULEs loaded during boot).
 */
function vfsPathFromLibRRequest(pathname: string): string | null {
  const rest = pathnameRelativeToScope(pathname);
  const marker = `${WASM_R_HOME}/`;
  if (rest !== WASM_R_HOME && !rest.startsWith(marker)) {
    return null;
  }
  if (rest.includes("..")) {
    return null;
  }
  return rest;
}

function vfsStaticResponse(
  body: ArrayBuffer,
  suffix: string,
  source: string,
  method: string,
): Response {
  const headers = new Headers({
    "Content-Type": mimeForAssetSuffix(suffix),
    "X-Httpuv-Static": source,
  });
  if (method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(body, { status: 200, headers });
}

/** Serve files under `/lib/R/**` directly from the wasm VFS. */
async function tryServeLibRAsset(request: Request): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }

  const url = new URL(request.url);
  const vfsPath = vfsPathFromLibRRequest(url.pathname);
  if (!vfsPath) {
    return null;
  }

  const suffix = vfsPath.slice(vfsPath.lastIndexOf("/") + 1);

  try {
    if (!rwasmHost) {
      void requestComlinkFromHost();
    }
    const host = await waitForRwasmHost();
    const body = await host.readVfsFileAt(vfsPath);
    if (!body) {
      httpuvDebugLog("sw-vfs-read-miss", { vfsPath });
      return null;
    }
    httpuvDebugLog("sw-static-hit", { vfsPath, source: "lib-r-vfs" });
    return vfsStaticResponse(body, suffix, "lib-r-vfs", request.method);
  } catch (err) {
    httpuvDebugLog("sw-vfs-read-fail", { vfsPath, err: String(err) });
    return null;
  }
}

/** Serve `/shiny/{prefix}/{suffix}` from synced resourcePaths() VFS dirs. */
async function tryServeShinyStaticAsset(request: Request): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }

  const url = new URL(request.url);
  if (!url.pathname.startsWith(shinyAppPrefix)) {
    return null;
  }

  const rest = url.pathname.slice(shinyAppPrefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) {
    return null;
  }

  const prefix = rest.slice(0, slash);
  const suffix = rest.slice(slash + 1);
  if (!suffix || suffix.includes("..")) {
    return null;
  }

  const localDir = shinyResourcePaths.get(prefix);
  if (!localDir || !rwasmHost) {
    return null;
  }

  try {
    const body = await rwasmHost.readVfsFile(localDir, suffix);
    if (!body) {
      httpuvDebugLog("sw-vfs-read-miss", { prefix, suffix, vfsDir: localDir });
      return null;
    }
    httpuvDebugLog("sw-static-hit", { prefix, suffix, source: "vfs", path: localDir });
    return vfsStaticResponse(body, suffix, "vfs", request.method);
  } catch (err) {
    httpuvDebugLog("sw-vfs-read-fail", { prefix, suffix, vfsDir: localDir, err: String(err) });
    return null;
  }
}

swSelf.addEventListener("install", (event) => {
  httpuvDebugLog("sw-install", { shinyPrefix: SHINY_PREFIX });
  event.waitUntil(swSelf.skipWaiting());
});

swSelf.addEventListener("activate", (event) => {
  httpuvDebugLog("sw-activate", { shinyPrefix: SHINY_PREFIX });
  resetRwasmHostWaiter();
  event.waitUntil(
    (async () => {
      await swSelf.clients.claim();
      // SW memory (hostClientId, Comlink) was wiped — ask Lucent to re-handshake.
      await requestComlinkFromHost();
    })(),
  );
});

function waitForHttpResponse(uuid: string, url: string, method: string): Promise<PendingResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHttp.delete(uuid);
      httpuvDebugLog("sw-timeout", { uuid, timeoutMs: REQUEST_TIMEOUT_MS });
      reject(new Error(`httpuv request ${uuid} timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    pendingHttp.set(uuid, { resolve, reject, timer, url, method });
  });
}

function maybeCacheAppDocument(resp: PendingResponse, url: string, method: string): void {
  if (url && method === "GET" && isAppDocumentRequest(url) && resp.status === 200) {
    cachedAppDocument = clonePendingResponse(resp);
    httpuvDebugLog("sw-app-cache-store", { url });
  }
}

function toFetchResponse(resp: PendingResponse): Response {
  const headers = new Headers(resp.headers ?? {});
  if (resp.body == null) {
    return new Response(null, { status: resp.status, headers });
  }
  return new Response(resp.body as BodyInit, { status: resp.status, headers });
}

async function headersToObject(request: Request): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
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

function cloneWsMessage(message: unknown, binary: boolean): unknown {
  if (message == null) {
    return null;
  }
  if (!binary) {
    if (typeof message === "string") {
      return message;
    }
    if (message instanceof ArrayBuffer) {
      return new TextDecoder().decode(message);
    }
    if (ArrayBuffer.isView(message)) {
      return new TextDecoder().decode(message);
    }
    return String(message);
  }
  // Always copy binary payloads. The buffer may already have been transferred
  // through Comlink; posting with a transfer list (or a detached buffer) throws
  // DataCloneError and used to tear down the session port.
  if (message instanceof ArrayBuffer) {
    return message.slice(0);
  }
  if (ArrayBuffer.isView(message)) {
    return message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength);
  }
  if (Array.isArray(message)) {
    return new Uint8Array(message as number[]).buffer;
  }
  return message;
}

function postWsPushToPort(port: MessagePort, handle: string, msg: WsPushMsg): boolean {
  const binary = Boolean(msg.binary);
  const payload = {
    type: MSG.WS_PUSH,
    handle,
    wsType: msg.wsType ?? WS_FRAME.SEND,
    binary,
    message: cloneWsMessage(msg.message ?? null, binary),
  };
  try {
    // Structured clone only — never transfer. Transferring a buffer that Comlink
    // already moved throws and would stall the session.
    port.postMessage(payload);
    return true;
  } catch (err) {
    console.warn("[httpuv-sw] session port postMessage failed", err);
    return false;
  }
}

function clearSessionPort(handle: string): void {
  const key = normalizeSessionHandle(handle);
  const port = sessionPorts.get(key);
  if (!port) {
    return;
  }
  sessionPorts.delete(key);
  try {
    port.close();
  } catch {
    // ignore
  }
}

/** Ask the iframe to transfer a fresh MessagePort (SW may have been killed while idle). */
function requestSessionPortReregister(handle: string): void {
  const key = normalizeSessionHandle(handle);
  if (!key || sessionPortReregisterPending.has(key)) {
    return;
  }
  const clientId = sessionClientIds.get(key);
  if (!clientId) {
    httpuvDebugLog("sw-session-reregister-no-client", { handle: key });
    return;
  }
  sessionPortReregisterPending.add(key);
  void swSelf.clients
    .get(clientId)
    .then((client) => {
      if (!client) {
        httpuvDebugLog("sw-session-reregister-client-gone", { handle: key, clientId });
        return;
      }
      httpuvDebugLog("sw-session-reregister", { handle: key, clientId });
      client.postMessage({ type: MSG.REQUEST_SESSION_PORT, handle: key });
    })
    .catch((err: unknown) => {
      console.warn("[httpuv-sw] REQUEST_SESSION_PORT failed", err);
    })
    .finally(() => {
      // Allow another nudge after a beat if the client never re-registered.
      setTimeout(() => {
        sessionPortReregisterPending.delete(key);
      }, 2_000);
    });
}

function queueWsPush(key: string, msg: WsPushMsg): void {
  const existing = queuedWsPush.get(key);
  if (existing) {
    existing.push(msg);
  } else {
    queuedWsPush.set(key, [msg]);
  }
}

function registerSessionPort(handle: string, port: MessagePort, clientId?: string): void {
  const key = normalizeSessionHandle(handle);
  clearSessionPort(key);
  if (clientId) {
    sessionClientIds.set(key, clientId);
  }
  sessionPortReregisterPending.delete(key);
  port.start();
  sessionPorts.set(key, port);
  httpuvDebugLog("sw-session-registered", { handle: key, clientId: sessionClientIds.get(key) });

  const queued = queuedWsPush.get(key);
  if (queued && queued.length > 0) {
    queuedWsPush.delete(key);
    while (queued.length > 0) {
      const next = queued[0]!;
      if (!postWsPushToPort(port, key, next)) {
        // Leave remaining frames queued; port stays registered for later pushes.
        queuedWsPush.set(key, queued);
        break;
      }
      queued.shift();
    }
  }

  try {
    port.postMessage({ type: MSG.SESSION_ACK, handle: key });
  } catch (err) {
    console.warn("[httpuv-sw] session ACK failed", err);
    clearSessionPort(key);
  }
}

function deliverWsPush(handle: string, msg: WsPushMsg): void {
  const key = normalizeSessionHandle(handle);
  const port = sessionPorts.get(key);
  httpuvDebugLog("sw-ws-push", {
    handle: key,
    wsType: msg.wsType,
    messageLen: messageBodyLength(msg.message),
    hasPort: Boolean(port),
    queuedBefore: queuedWsPush.get(key)?.length ?? 0,
  });

  if (port) {
    if (postWsPushToPort(port, key, msg)) {
      // Also flush anything left from a partial register drain.
      const queued = queuedWsPush.get(key);
      if (queued && queued.length > 0) {
        queuedWsPush.delete(key);
        while (queued.length > 0) {
          const next = queued[0]!;
          if (!postWsPushToPort(port, key, next)) {
            queuedWsPush.set(key, queued);
            clearSessionPort(key);
            requestSessionPortReregister(key);
            break;
          }
          queued.shift();
        }
      }
      return;
    }
    // Port looks dead (common after the browser stops the SW while idle).
    clearSessionPort(key);
    queueWsPush(key, msg);
    requestSessionPortReregister(key);
    return;
  }

  queueWsPush(key, msg);
  requestSessionPortReregister(key);
}

/** Legacy recv long-poll is retired; clients must REGISTER_SESSION. */
function handleSessionRecv(): Response {
  return new Response("session recv long-poll is retired; use REGISTER_SESSION MessagePort", {
    status: 410,
    headers: { "Content-Type": "text/plain" },
  });
}

function isShinyAppClientUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname;
    return pathname.startsWith(shinyAppPrefix) || pathname.startsWith(SHINY_PREFIX);
  } catch {
    return false;
  }
}

async function getHostClient(): Promise<Client | undefined> {
  if (hostClientId) {
    const client = await swSelf.clients.get(hostClientId);
    if (client) {
      return client;
    }
  }
  const clients = await swSelf.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  // Prefer the Lucent shell over the /shiny/ iframe. Chromium often returns the
  // focused iframe first after idle; that client does not handle host control msgs.
  return clients.find((c) => !isShinyAppClientUrl(c.url)) ?? clients[0];
}

function handleHostOutboundMessage(msg: HostOutbound): void {
  switch (msg.type) {
    case MSG.HTTP_RESPONSE: {
      httpuvDebugLog("sw-response", { uuid: msg.uuid, status: msg.status });
      const pending = msg.uuid ? pendingHttp.get(msg.uuid) : undefined;
      if (!pending || !msg.uuid) {
        httpuvDebugLog("sw-response-orphan", { uuid: msg.uuid });
        return;
      }
      clearTimeout(pending.timer);
      pendingHttp.delete(msg.uuid);
      const resp: PendingResponse = maybePatchAppDocumentResponse(
        {
          status: msg.status ?? 500,
          headers: msg.headers ?? {},
          body: msg.body ?? null,
        },
        pending.url,
        pending.method,
        isAppDocumentRequest,
      );
      maybeCacheAppDocument(resp, pending.url, pending.method);
      pending.resolve(resp);
      break;
    }
    case MSG.WS_PUSH: {
      if (!msg.handle) {
        httpuvDebugLog("sw-ws-push-missing-handle");
        return;
      }
      httpuvDebugLog("sw-ws-push-inbound", {
        handle: normalizeSessionHandle(msg.handle),
        wsType: msg.wsType,
        messageLen: messageBodyLength(msg.message),
      });
      deliverWsPush(normalizeSessionHandle(msg.handle), msg);
      break;
    }
    default:
      httpuvDebugLog("sw-unknown-push", { type: msg.type });
  }
}

async function handleHostPush(event: FetchEvent): Promise<Response> {
  try {
    const msg = (await event.request.json()) as HostOutbound;
    handleHostOutboundMessage(msg);
    return new Response(null, { status: 204 });
  } catch (err) {
    console.error("[httpuv-sw] host push failed", err);
    return new Response("bad host push payload", { status: 400 });
  }
}

async function handleShinyFetch(event: FetchEvent): Promise<Response> {
  const request = event.request;
  const uuid = crypto.randomUUID();
  httpuvDebugLog("sw-request", { uuid, method: request.method, url: request.url });

  const bypassAppCache = request.headers.get(WARMUP_REQUEST_HEADER) === "1";
  if (
    request.method === "GET" &&
    isAppDocumentRequest(request.url) &&
    cachedAppDocument &&
    !bypassAppCache
  ) {
    httpuvDebugLog("sw-app-cache-hit", { uuid, url: request.url });
    return toFetchResponse(clonePendingResponse(cachedAppDocument));
  }

  const staticRes = await tryServeShinyStaticAsset(request);
  if (staticRes) {
    return staticRes;
  }

  if (!rwasmHost) {
    void requestComlinkFromHost();
    try {
      await waitForRwasmHost();
    } catch (err) {
      console.error("[httpuv-sw] R worker not ready for", request.url, err);
      return new Response("Shiny R worker is not ready", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      });
    }
  }

  const host = rwasmHost;
  if (!host) {
    return new Response("Shiny R worker is not ready", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const body =
    request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();

  const responsePromise = waitForHttpResponse(uuid, request.url, request.method);

  const payload = {
    uuid,
    method: request.method,
    url: request.url,
    headers: await headersToObject(request),
    body,
    clientId: event.clientId,
  };

  const delivery = host
    .deliverHttpRequest(body ? Comlink.transfer(payload, [body]) : payload)
    .catch((err: unknown) => {
      console.error("[httpuv-sw] R worker request failed", err);
      throw err;
    });

  try {
    const resp = await responsePromise;
    await delivery;
    return toFetchResponse(resp);
  } catch (err) {
    const pending = pendingHttp.get(uuid);
    if (pending) {
      clearTimeout(pending.timer);
      pendingHttp.delete(uuid);
    }
    console.error("[httpuv-sw]", err);
    const failed = err instanceof Error && err.message.includes("request failed");
    return new Response(failed ? "Bad Gateway" : "Gateway Timeout", {
      status: failed ? 502 : 504,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

swSelf.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method === "GET" || event.request.method === "HEAD") {
    if (vfsPathFromLibRRequest(url.pathname)) {
      event.respondWith(
        (async () => {
          if (!rwasmHost) {
            void requestComlinkFromHost();
          }
          const served = await tryServeLibRAsset(event.request);
          return served ?? new Response("Not Found", { status: 404 });
        })(),
      );
      return;
    }
  }

  if (!pathUnderShinyPrefix(url.pathname)) {
    return;
  }

  if (
    isHostPushUrl(event.request.url, shinyAppPrefix) ||
    isHostPushUrl(event.request.url, SHINY_PREFIX)
  ) {
    event.respondWith(handleHostPush(event));
    return;
  }

  const session =
    parseSessionAction(event.request.url, shinyAppPrefix) ??
    parseSessionAction(event.request.url, SHINY_PREFIX);
  if (session?.action === "recv") {
    event.respondWith(handleSessionRecv());
    return;
  }

  event.respondWith(handleShinyFetch(event));
});

swSelf.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg === "skipWaiting" || msg?.type === "SKIP_WAITING") {
    void swSelf.skipWaiting();
    return;
  }
  if (!msg || typeof msg !== "object") {
    return;
  }

  if (msg.type === COMLINK.PORT_HANDOFF && event.ports[0]) {
    const port = event.ports[0];
    port.start();
    // Soft roll: keep in-flight waitForRwasmHost() waiters alive across handoff.
    rollRwasmHostWaiter();
    void connectSwToWorker(port);
    return;
  }

  if (msg.type === MSG.REGISTER_SESSION && event.ports[0]) {
    const handle = normalizeSessionHandle(msg.handle);
    if (!handle) {
      httpuvDebugLog("sw-session-register-missing-handle");
      try {
        event.ports[0].close();
      } catch {
        // ignore
      }
      return;
    }
    const source = event.source;
    const clientId = source && "id" in source ? String(source.id) : undefined;
    registerSessionPort(handle, event.ports[0], clientId);
    return;
  }

  if (typeof msg.type !== "string") {
    return;
  }

  switch (msg.type) {
    case MSG.REGISTER_HOST: {
      if (typeof msg.shinyPrefix === "string" && msg.shinyPrefix) {
        shinyAppPrefix = msg.shinyPrefix.endsWith("/") ? msg.shinyPrefix : `${msg.shinyPrefix}/`;
      }
      const source = event.source;
      if (source && "id" in source) {
        hostClientId = source.id;
        httpuvDebugLog("sw-host-registered", { hostClientId });
      }
      break;
    }

    case MSG.HTTP_RESPONSE: {
      handleHostOutboundMessage(msg as HostOutbound);
      break;
    }

    case MSG.WS_PUSH: {
      handleHostOutboundMessage(msg as HostOutbound);
      break;
    }

    case MSG.CLEAR_APP_CACHE: {
      clearCachedAppDocument();
      clearShinyResourcePaths();
      break;
    }

    case MSG.REGISTER_RESOURCE_PATHS: {
      setShinyResourcePaths(msg.paths);
      break;
    }

    case MSG.UPDATE_RESOURCE_PATH: {
      updateShinyResourcePath(String(msg.prefix ?? ""), msg.dir == null ? "" : String(msg.dir));
      break;
    }

    case MSG.STOP: {
      clearCachedAppDocument();
      clearShinyResourcePaths();
      for (const [uuid, pending] of pendingHttp) {
        clearTimeout(pending.timer);
        pending.reject(new Error("httpuv stopped"));
        pendingHttp.delete(uuid);
      }
      for (const handle of [...sessionPorts.keys()]) {
        clearSessionPort(handle);
      }
      sessionClientIds.clear();
      sessionPortReregisterPending.clear();
      queuedWsPush.clear();
      hostClientId = null;
      if (rwasmHost) {
        void rwasmHost.stop().catch((err: unknown) => {
          console.warn("[httpuv-sw] R worker stop failed", err);
        });
      }
      resetRwasmHostWaiter(new Error("httpuv stopped"));
      break;
    }

    default:
      break;
  }
});
