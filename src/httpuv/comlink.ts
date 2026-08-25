import * as Comlink from "comlink";
import { MSG } from "./constants";
import type { HeaderMap } from "./types";

export interface HttpResponsePayload {
  uuid: string;
  status?: number;
  headers?: HeaderMap;
  body?: ArrayBuffer | Uint8Array | string | null;
}

/** API the service worker exposes to the R worker for outbound httpuv traffic. */
export interface SwDeliveryApi {
  /** HTTP only — WS pushes use a dedicated one-way MessagePort. */
  deliverHttpResponse(resp: HttpResponsePayload): void;
}

/** API the R worker exposes to the service worker for inbound httpuv traffic. */
export interface RHostApi {
  /**
   * @param port Comlink channel for HTTP responses
   * @param wsPushPort one-way channel for WS pushes (ordered postMessage, no reply)
   */
  registerSwDelivery(port: MessagePort, wsPushPort: MessagePort): void | Promise<void>;
  deliverHttpRequest(req: unknown): Promise<void>;
  getShinyResourcePaths(): Promise<Record<string, string>>;
  readVfsFile(vfsDir: string, suffix: string): Promise<ArrayBuffer | null>;
  readVfsFileAt(vfsPath: string): Promise<ArrayBuffer | null>;
  stop(): void | Promise<void>;
}

/**
 * Build the API exposed by the service worker for outbound httpuv traffic.
 * The delivery callback formats messages the SW can route back to fetch waiters.
 */
export function createSwDeliveryApi(deliverOutbound: (msg: object) => void): SwDeliveryApi {
  return {
    deliverHttpResponse(resp: HttpResponsePayload) {
      deliverOutbound({
        type: MSG.HTTP_RESPONSE,
        uuid: resp.uuid,
        status: resp.status ?? 500,
        headers: resp.headers ?? {},
        body: resp.body ?? null,
      });
    },
  };
}

export { Comlink };
