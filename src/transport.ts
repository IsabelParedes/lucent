import type { HostInboundMessage } from "./wiring";

export interface MsgTypes {
  REGISTER_HOST: string;
  HTTP_REQUEST: string;
  HTTP_RESPONSE: string;
  WS_PUSH: string;
  STOP: string;
  CLEAR_APP_CACHE: string;
  REGISTER_RESOURCE_PATHS: string;
  UPDATE_RESOURCE_PATH: string;
  REQUEST_COMLINK: string;
  REGISTER_SESSION: string;
  SESSION_ACK: string;
  REQUEST_SESSION_PORT: string;
  [key: string]: string;
}

export interface ChannelTypes {
  HTTP_REQUEST: string;
  TCP_RESPONSE: string;
  WS_OPEN: string;
  WS_MESSAGE: string;
  WS_CLOSE: string;
  WS_RESPONSE: string;
  STDIN: string;
  [key: string]: string;
}

export interface ComlinkTypes {
  PORT_HANDOFF: string;
  /** Absent on transport bundles built before the handoff ack was added. */
  PORT_HANDOFF_ACK?: string;
  [key: string]: string | undefined;
}

/** Loose shape of a channel message pushed into R (buildReq / WS frames). */
export interface ChannelMessageLike {
  type: string;
  uuid?: string;
  handle?: string;
  binary?: boolean;
  message?: unknown;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | number[] | null;
  req?: unknown;
  clientId?: string | null;
  data?: unknown;
}

/** Loose shape of an outbound message the bridge posts to the service worker. */
export interface OutboundMessage {
  type: string;
  uuid?: string;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  handle?: string;
  binary?: boolean;
  wsType?: string;
  message?: unknown;
}

export interface HttpuvBridgeOptions {
  postOutbound?: (msg: OutboundMessage, transfer?: Transferable[]) => void;
  installSwListener?: boolean;
  pushToR?: (msg: ChannelMessageLike) => void;
  requestHostService?: () => void;
  scheduleHostDelay?: (delayMs: number) => void;
}

/**
 * The public surface of httpuv-web.js that Lucent consumes at runtime.
 * Kept as a hand-written contract so runApp/rWasmWorker stay decoupled from
 * the transport bundle's build graph (loaded via dynamic import).
 */
export interface HttpuvTransport {
  MSG: MsgTypes;
  CHANNEL: ChannelTypes;
  COMLINK: ComlinkTypes;
  REQUEST_TIMEOUT_MS: number;
  WARMUP_REQUEST_HEADER: string;
  installHttpuvBridge(options?: HttpuvBridgeOptions): unknown;
  flushDeferredOutbound(): void;
  pushInboundHostMessage(msg: HostInboundMessage): void;
  channelMessageToRExpr(msg: ChannelMessageLike): string;
  isLikelyStaticAsset(url: string): boolean;
  isSessionHttpRequest(url: string, prefix?: string): boolean;
  normalizeSessionHandle(handle: unknown): string;
  getShinyPrefix(): string;
  setShinyPrefix(prefix: string): void;
  resolveShinyPrefix(fromUrl: string | URL): string;
  shinyAppUrl(subpath?: string, fromUrl?: string | URL): string;
  isHttpuvDebug(): boolean;
  httpuvDebugLog(stage: string, ...args: unknown[]): void;
  enableHttpuvDebug(): void;
}

let cached: Promise<HttpuvTransport> | null = null;

function transportUrl(baseUrl: string): string {
  const base = new URL(baseUrl, self.location.href);
  return new URL("httpuv-web.js", base).href;
}

/**
 * Dynamically load the httpuv transport module (`httpuv-web.js`) served from
 * `baseUrl` (typically Lucent dist). The result is cached; the specifier is a
 * runtime value so the bundler leaves it as a live `import()` instead of
 * inlining the transport.
 */
export function loadTransport(baseUrl: string): Promise<HttpuvTransport> {
  if (!cached) {
    const url = transportUrl(baseUrl);
    cached = import(/* @vite-ignore */ /* webpackIgnore: true */ url) as Promise<HttpuvTransport>;
  }
  return cached;
}
