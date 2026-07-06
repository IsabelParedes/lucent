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
}

/** API the R worker exposes to the service worker (Comlink target). */
export interface RHostApi {
  registerSwDelivery(port: MessagePort): void | Promise<void>;
  deliverHttpRequest(req: HostHttpRequest): void | Promise<void>;
  getShinyResourcePaths(): Promise<Record<string, string>>;
  readVfsFile(vfsDir: string, suffix: string): Promise<ArrayBuffer | null>;
  stop(): void | Promise<void>;
}

/** Reverse delivery API the service worker exposes to the R worker (Comlink target). */
export interface SwDeliveryApi {
  deliverHttpResponse(resp: unknown): void | Promise<void>;
  deliverWsPush(msg: unknown): void | Promise<void>;
}

/**
 * Broker a single Comlink MessagePort between the service worker and R worker.
 * The SW creates a reverse delivery channel after wrapping the worker API.
 *
 * @param portHandoffType transport COMLINK.PORT_HANDOFF message type
 */
export async function connectHttpuvComlink(
  rWorker: Worker,
  portHandoffType: string,
): Promise<void> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    throw new Error("Service worker controller is not available for Comlink setup");
  }

  const readyPromise = waitForComlinkReady(rWorker);

  const channel = new MessageChannel();
  controller.postMessage({ type: portHandoffType }, [channel.port1]);
  rWorker.postMessage({ type: RWASM.COMLINK_PORT }, [channel.port2]);

  await readyPromise;
  console.info("[lucent] service worker <-> R worker connected (unified port)");
}

function waitForComlinkReady(rWorker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      rWorker.removeEventListener("message", onMessage);
      reject(new Error("Comlink setup timed out"));
    }, 30_000);

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === RWASM.COMLINK_READY) {
        clearTimeout(deadline);
        rWorker.removeEventListener("message", onMessage);
        resolve();
      }
      if (event.data?.type === RWASM.ERROR) {
        clearTimeout(deadline);
        rWorker.removeEventListener("message", onMessage);
        reject(new Error(event.data.message ?? "R worker Comlink setup failed"));
      }
    };

    rWorker.addEventListener("message", onMessage);
  });
}

/**
 * Build the API exposed by the R worker for inbound httpuv traffic.
 *
 * @param httpRequestType transport MSG.HTTP_REQUEST message type
 */
export function createRHostApi(httpRequestType: string, handlers: RHostHandlers): RHostApi {
  const { onHttpRequest, onStop, getResourcePaths, registerSwDelivery, readVfsFile } = handlers;
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
    stop() {
      onStop();
    },
  };
}
