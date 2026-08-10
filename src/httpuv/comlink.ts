import * as Comlink from "comlink";
import { MSG } from "./constants";
import type { HeaderMap } from "./types";

export interface HttpResponsePayload {
  uuid: string;
  status?: number;
  headers?: HeaderMap;
  body?: ArrayBuffer | Uint8Array | string | null;
}

export interface WsPushPayload {
  handle: string;
  binary?: boolean;
  wsType?: string;
  message?: unknown;
}

/** API the service worker exposes to the R worker for outbound httpuv traffic. */
export interface SwDeliveryApi {
  deliverHttpResponse(resp: HttpResponsePayload): void;
  deliverWsPush(msg: WsPushPayload): void;
}

/** API the R worker exposes to the service worker for inbound httpuv traffic. */
export interface RHostApi {
  registerSwDelivery(port: MessagePort): void | Promise<void>;
  deliverHttpRequest(req: unknown): Promise<void>;
  getShinyResourcePaths(): Promise<Record<string, string>>;
  readVfsFile(vfsDir: string, suffix: string): Promise<ArrayBuffer | null>;
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
    deliverWsPush(msg: WsPushPayload) {
      deliverOutbound({
        type: MSG.WS_PUSH,
        handle: msg.handle,
        binary: msg.binary ?? false,
        wsType: msg.wsType,
        message: msg.message ?? null,
      });
    },
  };
}

export { Comlink };
