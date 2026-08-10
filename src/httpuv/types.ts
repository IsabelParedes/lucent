export type HeaderMap = Record<string, string>;

/** A message on Module.httpuv.channel (the R <-> JS bridge). */
export interface ChannelMessage {
  type: string;
  uuid?: string;
  handle?: string;
  binary?: boolean;
  message?: unknown;
  method?: string;
  url?: string;
  headers?: HeaderMap;
  body?: ArrayBuffer | number[] | null;
  req?: unknown;
  clientId?: string | null;
  data?: ChannelMessageData;
}

export interface ChannelMessageData {
  status?: number;
  headers?: HeaderMap;
  body?: unknown;
  handle?: string;
  binary?: boolean;
  type?: string;
  message?: unknown;
}

/** Request env fields buildReq needs from an inbound HTTP message. */
export interface HttpRequestInput {
  uuid: string;
  method: string;
  url: string;
  headers?: HeaderMap;
  body?: ArrayBuffer | null;
}

/** Response payload buffered/forwarded between the R worker and service worker. */
export interface PendingResponse {
  status: number;
  headers: HeaderMap;
  body: ArrayBuffer | Uint8Array | string | null;
}

/** Callback R registers so the bridge can invoke httpuv option handlers. */
export type InvokeROption = (optionName: string, ...args: unknown[]) => boolean;

/** Deliver an outbound host message (main page -> service worker). */
export type OutboundDeliver = (msg: object, transfer?: Transferable[]) => void;

export interface HttpuvChannel {
  inbox: ChannelMessage[];
  hasMessage(): boolean;
  read(): ChannelMessage;
  write(msg: ChannelMessage): void;
}

export interface HttpuvModule {
  channel?: HttpuvChannel;
  dispatch?: (msg: ChannelMessage) => void;
  drainInboundChannel?: () => void;
  pushInboundChannelMessage?: (msg: ChannelMessage) => boolean;
  pushInboundHostMessage?: (msg: HostInboundMessage) => void;
  buildReq?: (msg: HttpRequestInput) => Record<string, unknown>;
  injectShinySocketBootstrap?: (html: string) => string;
  shinySocketScriptUrl?: () => string;
  shinyPrefix?: string;
  pushWsMessage?: (
    handle: string,
    message: unknown,
    opts?: { binary?: boolean; wsType?: string },
  ) => void;
  bindInvokeROption?: (fn: InvokeROption) => void;
  /** Shiny host mode: request an immediate host service wake. */
  requestHostService?: () => void;
  /** Shiny host mode: wake after delayMs (setTimeout → MessageChannel). */
  scheduleHostDelay?: (delayMs: number) => void;
  _swListenerInstalled?: boolean;
  [key: string]: unknown;
}

/** Inbound message from the service worker (or a host proxy) to the R worker. */
export interface HostInboundMessage {
  type: string;
  uuid?: string;
  method?: string;
  url?: string;
  headers?: HeaderMap;
  body?: ArrayBuffer | null;
  clientId?: string | null;
}
