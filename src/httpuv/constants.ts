/** WebSocket frame types used by httpuv (mirrors native httpuv). */
export const WS_FRAME = {
  SEND: "websocket.send",
  CLOSE: "websocket.close",
} as const;

/** R_HOME inside the mounted wasm prefix (VFS root is /). */
export const WASM_R_HOME = "/lib/R";

/** Max time the service worker waits for the R worker to answer a request. */
export const REQUEST_TIMEOUT_MS = 180_000;

/** Message types exchanged between the service worker and the main page. */
export const MSG = {
  REGISTER_HOST: "httpuv_register_host",
  HTTP_REQUEST: "httpuv_http_request",
  HTTP_RESPONSE: "httpuv_http_response",
  WS_PUSH: "httpuv_ws_push",
  STOP: "httpuv_stop",
  /** Drop cached GET /shiny/ without tearing down the R worker (app restart). */
  CLEAR_APP_CACHE: "httpuv_clear_app_cache",
  /** Ask the SW to refresh shiny::resourcePaths() from the R worker. */
  SYNC_RESOURCE_PATHS: "httpuv_sync_resource_paths",
  /** R worker -> SW mapping of addResourcePath prefixes to VFS directories. */
  REGISTER_RESOURCE_PATHS: "httpuv_register_resource_paths",
  /** SW -> host: Comlink to the R worker was lost (e.g. after SW update). */
  REQUEST_COMLINK: "httpuv_request_comlink",
  /** Iframe → SW: transfer a MessagePort for session WS push delivery. */
  REGISTER_SESSION: "httpuv_register_session",
  /** SW → iframe (on session port): registration accepted. */
  SESSION_ACK: "httpuv_session_ack",
  /** SW → iframe client: session MessagePort was lost (e.g. SW idle restart); re-REGISTER_SESSION. */
  REQUEST_SESSION_PORT: "httpuv_request_session_port",
} as const;

/** Bypass SW app-document cache (warmup must hit R so deps register). */
export const WARMUP_REQUEST_HEADER = "X-Shiny-Forge-Warmup";

/** Message types on Module.httpuv.channel (R <-> JS bridge). */
export const CHANNEL = {
  HTTP_REQUEST: "httpuv_http_request",
  TCP_RESPONSE: "httpuv_tcp_response",
  WS_OPEN: "httpuv_ws_open",
  WS_MESSAGE: "httpuv_ws_message",
  WS_CLOSE: "httpuv_ws_close",
  WS_RESPONSE: "httpuv_ws_response",
  STDIN: "stdin",
} as const;

/** R option names registered by httpuv::startServer(). */
export const HTTPUV_OPTIONS = {
  ON_REQUEST: "httpuv_onRequest",
  ON_WS_OPEN: "httpuv_onWSOpen",
  ON_WS_MESSAGE: "httpuv_onWSMessage",
  ON_WS_CLOSE: "httpuv_onWSClose",
} as const;

/** Comlink MessagePort handshake between host page, service worker, and R worker. */
export const COMLINK = {
  PORT_HANDOFF: "httpuv_comlink_port",
} as const;
