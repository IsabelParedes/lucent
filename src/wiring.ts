import { lucentInfo } from "./debug";
import { RWASM } from "./rwasm-constants";

/** Inbound HTTP request payload the service worker sends over Comlink. */
export interface HostHttpRequest {
  uuid?: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | null;
  clientId?: string | null;
}

/** Normalized inbound message handed to the R worker's push handler. */
export interface HostInboundMessage {
  type: string;
  uuid?: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | null;
  clientId?: string | null;
}

export interface RHostHandlers {
  onHttpRequest: (msg: HostInboundMessage) => void | Promise<void>;
  onStop: () => void;
  getResourcePaths: () => Promise<Record<string, string>>;
  registerSwDelivery: (port: MessagePort) => void;
  readVfsFile: (vfsDir: string, suffix: string) => Promise<ArrayBuffer | null>;
  readVfsFileAt: (vfsPath: string) => Promise<ArrayBuffer | null>;
}

/** API the R worker exposes to the service worker (Comlink target). */
export interface RHostApi {
  registerSwDelivery(port: MessagePort): void | Promise<void>;
  deliverHttpRequest(req: HostHttpRequest): void | Promise<void>;
  getShinyResourcePaths(): Promise<Record<string, string>>;
  readVfsFile(vfsDir: string, suffix: string): Promise<ArrayBuffer | null>;
  readVfsFileAt(vfsPath: string): Promise<ArrayBuffer | null>;
  stop(): void | Promise<void>;
}

/** Reverse delivery API the service worker exposes to the R worker (Comlink target). */
export interface SwDeliveryApi {
  deliverHttpResponse(resp: unknown): void | Promise<void>;
  deliverWsPush(msg: unknown): void | Promise<void>;
}

/** Times the handoff is re-posted before giving up (needs `ackType`). */
const HANDOFF_ATTEMPTS = 3;

/** Wait for the service worker to confirm the port before re-posting it. */
const HANDOFF_ACK_TIMEOUT_MS = 5_000;

/** Wait for the R worker to report both halves of the handshake complete. */
const COMLINK_READY_TIMEOUT_MS = 30_000;

export interface ComlinkHandshakeOptions {
  /**
   * Transport `COMLINK.PORT_HANDOFF_ACK` type. Omit for transport bundles built
   * before the ack existed: without it a missing `COMLINK_READY` cannot be told
   * apart from a slow one, so the handoff is posted only once.
   */
  ackType?: string;
  attempts?: number;
  ackTimeoutMs?: number;
  readyTimeoutMs?: number;
}

interface Watcher<T> {
  promise: Promise<T>;
  cancel: () => void;
}

type HandshakeOutcome = "ready" | "acked" | "pending";

/**
 * Broker a single Comlink MessagePort between the service worker and R worker.
 * The SW creates a reverse delivery channel after wrapping the worker API.
 *
 * The R worker only reports `COMLINK_READY` once the SW has called back into it
 * (`registerSwDelivery`), so this handshake spans all three parties. A service
 * worker evicted while R boots can silently drop the handoff — `postMessage`
 * with a transferred port races the worker's restart — hence the retries.
 *
 * @param portHandoffType transport COMLINK.PORT_HANDOFF message type
 */
export async function connectHttpuvComlink(
  rWorker: Worker,
  portHandoffType: string,
  options: ComlinkHandshakeOptions = {},
): Promise<void> {
  const {
    ackType,
    attempts = HANDOFF_ATTEMPTS,
    ackTimeoutMs = HANDOFF_ACK_TIMEOUT_MS,
    readyTimeoutMs = COMLINK_READY_TIMEOUT_MS,
  } = options;

  const ready = watchWorkerComlinkReady(rWorker);
  // Retries share the overall budget rather than extending it.
  const deadline = Date.now() + readyTimeoutMs;
  const maxAttempts = ackType ? Math.max(1, attempts) : 1;
  let connected = false;
  let acked = false;

  try {
    for (let attempt = 1; attempt <= maxAttempts && !connected && !acked; attempt += 1) {
      const ack = ackType ? watchServiceWorkerMessage(ackType) : null;
      try {
        postComlinkPorts(rWorker, portHandoffType);
        const outcome = await raceHandshake(ready.promise, ack?.promise, ackTimeoutMs);
        connected = outcome === "ready";
        acked = outcome === "acked";
        if (outcome === "pending") {
          lucentInfo(
            `[lucent] service worker did not confirm the Comlink port handoff (attempt ${attempt}/${maxAttempts})`,
          );
        }
      } finally {
        ack?.cancel();
      }
    }

    if (!connected) {
      await waitFor(ready.promise, Math.max(0, deadline - Date.now()), () =>
        comlinkTimeoutError(Boolean(ackType), acked),
      );
    }
    lucentInfo("[lucent] service worker <-> R worker connected (unified port)");
  } finally {
    ready.cancel();
  }
}

/** Hand one end of a fresh channel to the SW and the other to the R worker. */
function postComlinkPorts(rWorker: Worker, portHandoffType: string): void {
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    throw new Error("Service worker controller is not available for Comlink setup");
  }

  const channel = new MessageChannel();
  controller.postMessage({ type: portHandoffType }, [channel.port1]);
  rWorker.postMessage({ type: RWASM.COMLINK_PORT }, [channel.port2]);
}

function comlinkTimeoutError(canAck: boolean, acked: boolean): Error {
  if (!canAck) {
    return new Error("Comlink setup timed out");
  }
  if (acked) {
    return new Error(
      "Comlink setup timed out: the service worker took the port but the R worker never completed setup",
    );
  }
  return new Error(
    "Comlink setup timed out: the service worker never acknowledged the port handoff",
  );
}

async function raceHandshake(
  ready: Promise<void>,
  ack: Promise<void> | undefined,
  timeoutMs: number,
): Promise<HandshakeOutcome> {
  const timer = timeoutWatcher(timeoutMs);
  try {
    return await Promise.race<HandshakeOutcome>([
      ready.then((): HandshakeOutcome => "ready"),
      ...(ack ? [ack.then((): HandshakeOutcome => "acked")] : []),
      timer.promise.then((): HandshakeOutcome => "pending"),
    ]);
  } finally {
    timer.cancel();
  }
}

async function waitFor(
  promise: Promise<void>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<void> {
  const timer = timeoutWatcher(timeoutMs);
  try {
    const timedOut = await Promise.race([
      promise.then(() => false),
      timer.promise.then(() => true),
    ]);
    if (timedOut) {
      throw onTimeout();
    }
  } finally {
    timer.cancel();
  }
}

function timeoutWatcher(ms: number): Watcher<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** Settles when the R worker finishes (or fails) Comlink setup. */
function watchWorkerComlinkReady(rWorker: Worker): Watcher<void> {
  let cleanup = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === RWASM.COMLINK_READY) {
        cleanup();
        resolve();
      }
      if (event.data?.type === RWASM.ERROR) {
        cleanup();
        reject(new Error(event.data.message ?? "R worker Comlink setup failed"));
      }
    };
    cleanup = () => rWorker.removeEventListener("message", onMessage);
    rWorker.addEventListener("message", onMessage);
  });
  return { promise, cancel: () => cleanup() };
}

/** Resolves on the first service worker message of `type`. */
function watchServiceWorkerMessage(type: string): Watcher<void> {
  let cleanup = () => {};
  const promise = new Promise<void>((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === type) {
        cleanup();
        resolve();
      }
    };
    cleanup = () => navigator.serviceWorker.removeEventListener("message", onMessage);
    navigator.serviceWorker.addEventListener("message", onMessage);
  });
  return { promise, cancel: () => cleanup() };
}

/**
 * Build the API exposed by the R worker for inbound httpuv traffic.
 *
 * @param httpRequestType transport MSG.HTTP_REQUEST message type
 */
export function createRHostApi(httpRequestType: string, handlers: RHostHandlers): RHostApi {
  const { onHttpRequest, onStop, getResourcePaths, registerSwDelivery, readVfsFile, readVfsFileAt } =
    handlers;
  return {
    registerSwDelivery(port: MessagePort) {
      registerSwDelivery(port);
    },
    deliverHttpRequest(req: HostHttpRequest) {
      return onHttpRequest({
        type: httpRequestType,
        uuid: req.uuid,
        method: req.method,
        url: req.url,
        headers: req.headers ?? {},
        body: req.body ?? null,
        clientId: req.clientId ?? null,
      });
    },
    getShinyResourcePaths() {
      return getResourcePaths();
    },
    readVfsFile(vfsDir: string, suffix: string) {
      return readVfsFile(vfsDir, suffix);
    },
    readVfsFileAt(vfsPath: string) {
      return readVfsFileAt(vfsPath);
    },
    stop() {
      onStop();
    },
  };
}
