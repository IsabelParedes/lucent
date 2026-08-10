/**
 * Virtual WebSocket for Shiny in the browser.
 * Loaded as a module in the Shiny app iframe; overrides Shiny.createSocket.
 *
 * Server→client frames arrive on a dedicated MessagePort registered with the
 * httpuv service worker (no recv long-poll). open/send/close still use fetch.
 *
 * After the browser stops the SW while idle, the port is gone but the socket
 * stays logically open: we re-REGISTER_SESSION on send, visibilitychange, and
 * when the SW asks via REQUEST_SESSION_PORT.
 */

import { MSG, WS_FRAME } from "./constants";
import { httpuvDebugLog } from "./debug";

/** How long to wait for SESSION_ACK after REGISTER_SESSION. */
const SESSION_REGISTER_TIMEOUT_MS = 5_000;

/** Build an absolute session URL under the Shiny app prefix. */
function sessionUrl(action: string, opts: { handle?: string } = {}): string {
  const base = new URL("__session__/", location.href);
  const url = new URL(action.replace(/^\//, ""), base);
  if (opts.handle) {
    url.searchParams.set("handle", opts.handle);
  }
  return url.href;
}

type SessionPortMessage = {
  type?: string;
  handle?: string;
  wsType?: string;
  binary?: boolean;
  message?: unknown;
};

const socketsByHandle = new Map<string, VirtualShinySocket>();

/** Minimal WebSocket stand-in using session fetch + MessagePort push delivery. */
export class VirtualShinySocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = VirtualShinySocket.CONNECTING;
  binaryType: BinaryType = "arraybuffer";

  private _handle: string | null = null;
  private _active = false;
  private _port: MessagePort | null = null;
  private _registering: Promise<void> | null = null;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor() {
    void this._connect();
  }

  private async _connect(): Promise<void> {
    try {
      const openUrl = sessionUrl("open");
      httpuvDebugLog("socket-open", openUrl);
      const res = await fetch(openUrl, { method: "POST" });
      if (!res.ok) {
        throw new Error(`session open failed: HTTP ${res.status}`);
      }
      const { handle } = (await res.json()) as { handle?: string };
      if (!handle) {
        throw new Error("session open response missing handle");
      }
      this._handle = String(handle);
      this.readyState = VirtualShinySocket.OPEN;
      this._active = true;
      socketsByHandle.set(this._handle, this);

      await this.ensurePort();

      this.onopen?.(new Event("open"));
    } catch (err) {
      console.error("[shiny-socket] connect failed", err);
      this._teardownPort();
      this.readyState = VirtualShinySocket.CLOSED;
      this.onerror?.(new Event("error"));
      this.onclose?.(new CloseEvent("close", { code: 1006, wasClean: false }));
    }
  }

  /**
   * Ensure the SW has a live MessagePort for this session.
   * Safe to call repeatedly after idle SW restarts.
   */
  ensurePort(): Promise<void> {
    if (!this._active || !this._handle) {
      return Promise.resolve();
    }
    if (this._registering) {
      return this._registering;
    }
    this._registering = this._registerSessionPort(this._handle).finally(() => {
      this._registering = null;
    });
    return this._registering;
  }

  /** Hand a MessagePort to the SW and wait for SESSION_ACK. */
  private async _registerSessionPort(handle: string): Promise<void> {
    const controller = navigator.serviceWorker?.controller;
    if (!controller) {
      throw new Error("no service worker controller for session port");
    }

    if (this._port) {
      try {
        this._port.close();
      } catch {
        // ignore
      }
      this._port = null;
    }

    const channel = new MessageChannel();
    this._port = channel.port1;

    const acked = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("session port registration timed out"));
      }, SESSION_REGISTER_TIMEOUT_MS);

      this._port!.onmessage = (event: MessageEvent<SessionPortMessage>) => {
        const data = event.data;
        if (data?.type === MSG.SESSION_ACK) {
          clearTimeout(timer);
          this._port!.onmessage = (ev) => this._onPortMessage(ev);
          resolve();
          return;
        }
        this._onPortMessage(event);
      };

      this._port!.onmessageerror = () => {
        clearTimeout(timer);
        reject(new Error("session port messageerror"));
      };
    });

    httpuvDebugLog("socket-register-session", { handle });
    controller.postMessage({ type: MSG.REGISTER_SESSION, handle }, [channel.port2]);
    await acked;
  }

  private _onPortMessage(event: MessageEvent<SessionPortMessage>): void {
    if (!this._active) {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== "object") {
      return;
    }

    if (data.type !== MSG.WS_PUSH && data.wsType == null && data.message === undefined) {
      return;
    }

    const wsType = data.wsType ?? WS_FRAME.SEND;
    if (wsType === WS_FRAME.CLOSE) {
      let code = 1000;
      let reason = "";
      try {
        const raw = data.message;
        if (typeof raw === "string" && raw) {
          const payload = JSON.parse(raw) as { code?: number; reason?: string };
          code = Number(payload.code ?? code);
          reason = String(payload.reason ?? "");
        }
      } catch {
        // ignore malformed close payloads
      }
      this._finishClose(code, reason, true);
      return;
    }

    const binary = Boolean(data.binary);
    let payload: string | ArrayBuffer;
    if (binary) {
      if (data.message instanceof ArrayBuffer) {
        payload = data.message;
      } else if (ArrayBuffer.isView(data.message)) {
        const view = data.message;
        payload = view.buffer.slice(
          view.byteOffset,
          view.byteOffset + view.byteLength,
        ) as ArrayBuffer;
      } else if (typeof data.message === "string") {
        payload = data.message;
      } else {
        payload = new ArrayBuffer(0);
      }
    } else if (typeof data.message === "string") {
      payload = data.message;
    } else if (data.message instanceof ArrayBuffer) {
      payload = new TextDecoder().decode(data.message);
    } else if (ArrayBuffer.isView(data.message)) {
      payload = new TextDecoder().decode(data.message);
    } else {
      payload = String(data.message ?? "");
    }

    httpuvDebugLog("socket-recv", {
      wsType,
      binary,
      bytes: typeof payload === "string" ? payload.length : payload.byteLength,
    });
    this.onmessage?.(new MessageEvent("message", { data: payload }));
  }

  private _teardownPort(): void {
    this._active = false;
    if (this._handle) {
      socketsByHandle.delete(this._handle);
    }
    if (this._port) {
      try {
        this._port.close();
      } catch {
        // ignore
      }
      this._port = null;
    }
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== VirtualShinySocket.OPEN || !this._handle) {
      throw new Error("WebSocket is not open");
    }

    let body: string | ArrayBuffer;
    let byteLen: number;
    let isBinary: boolean;
    if (typeof data === "string") {
      body = data;
      byteLen = data.length;
      isBinary = false;
    } else if (data instanceof ArrayBuffer) {
      body = data;
      byteLen = data.byteLength;
      isBinary = true;
    } else {
      body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      byteLen = data.byteLength;
      isBinary = true;
    }

    const handle = this._handle;
    const sendUrl = sessionUrl("send", { handle });
    httpuvDebugLog("socket-send", sendUrl, {
      binary: isBinary,
      bytes: byteLen,
    });

    // Re-attach the session port first so server replies are not queued forever
    // after the browser stopped the SW during idle.
    void this.ensurePort()
      .catch((err) => {
        console.warn("[shiny-socket] ensurePort before send failed", err);
      })
      .then(() =>
        fetch(sendUrl, {
          method: "POST",
          headers: isBinary ? {} : { "Content-Type": "text/plain; charset=UTF-8" },
          body,
        }),
      )
      .catch((err) => {
        console.error("[shiny-socket] send failed", err);
      });
  }

  close(code = 1000, reason = ""): void {
    if (
      this.readyState === VirtualShinySocket.CLOSED ||
      this.readyState === VirtualShinySocket.CLOSING
    ) {
      return;
    }
    this.readyState = VirtualShinySocket.CLOSING;
    const handle = this._handle;
    this._active = false;
    if (handle) {
      const closeUrl = sessionUrl("close", { handle });
      void fetch(closeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, reason }),
      }).catch((err) => {
        console.error("[shiny-socket] close failed", err);
      });
    }
    this._finishClose(code, reason, true);
  }

  private _finishClose(code: number, reason: string, wasClean: boolean): void {
    if (this.readyState === VirtualShinySocket.CLOSED) {
      return;
    }
    this._teardownPort();
    this.readyState = VirtualShinySocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason, wasClean }));
  }
}

function reregisterAllSockets(): void {
  for (const sock of socketsByHandle.values()) {
    void sock.ensurePort().catch((err) => {
      console.warn("[shiny-socket] ensurePort failed", err);
    });
  }
}

function installSessionPortRecovery(): void {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) {
    return;
  }
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: string; handle?: string } | null;
    if (!data || data.type !== MSG.REQUEST_SESSION_PORT) {
      return;
    }
    const handle = data.handle ? String(data.handle) : "";
    const sock = handle ? socketsByHandle.get(handle) : undefined;
    if (sock) {
      void sock.ensurePort().catch((err) => {
        console.warn("[shiny-socket] REQUEST_SESSION_PORT ensurePort failed", err);
      });
      return;
    }
    reregisterAllSockets();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      reregisterAllSockets();
    }
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    reregisterAllSockets();
  });
}

/** Install VirtualShinySocket as Shiny.createSocket (call before Shiny connects). */
export function installVirtualShinySocket(): void {
  const factory = () => new VirtualShinySocket();

  const apply = () => {
    if (typeof globalThis.Shiny === "object" && globalThis.Shiny !== null) {
      globalThis.Shiny.createSocket = factory;
    } else {
      globalThis.Shiny = { createSocket: factory };
    }
  };

  apply();
  document.addEventListener("DOMContentLoaded", apply, { once: true });
  installSessionPortRecovery();
  httpuvDebugLog("shiny-socket-installed");
}

installVirtualShinySocket();
