import { CHANNEL } from "./constants";
import type { ChannelMessage } from "./types";

/** Double-encode a value as a JSON string literal safe to embed in R source. */
export function jsonForR(value: unknown): string {
  return JSON.stringify(JSON.stringify(value));
}

export function serializeReqForR(req: Record<string, unknown>): Record<string, unknown> {
  const out = { ...req };
  const body = out.body;
  if (body instanceof ArrayBuffer) {
    out.body = Array.from(new Uint8Array(body));
  } else if (ArrayBuffer.isView(body)) {
    out.body = Array.from(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    );
  }
  return out;
}

function encodeWsPayloadBytes(message: unknown, binary: boolean): number[] {
  if (binary) {
    if (message instanceof ArrayBuffer) {
      return Array.from(new Uint8Array(message));
    }
    if (ArrayBuffer.isView(message)) {
      return Array.from(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
    }
    if (Array.isArray(message)) {
      return message as number[];
    }
  }
  return Array.from(new TextEncoder().encode(String(message ?? "")));
}

export function isLikelyStaticAsset(url: string): boolean {
  return (
    /\.(js|css|png|jpe?g|gif|svg|woff2?|ico|map)(\?|$)/i.test(url) ||
    /\/shiny\/(shared|jquery|bootstrap|htmltools|shiny-)/i.test(url)
  );
}

/** Build an R expression that pushes a channel message into httpuv handlers. */
export function channelMessageToRExpr(msg: ChannelMessage): string {
  switch (msg.type) {
    case CHANNEL.HTTP_REQUEST: {
      const payload = {
        uuid: msg.uuid,
        method: msg.method,
        url: msg.url,
        headers: msg.headers ?? {},
        body: msg.body ?? null,
      };
      const msgJson = jsonForR(payload);

      // Always synchronous in the WASM host: later::later never reliably fires
      // from Chromium dedicated workers, which left the SW waiting until 503.
      return `local({
  msg <- jsonlite::fromJSON(${msgJson}, simplifyVector=FALSE)
  wrapper <- get("active_app_wrapper", envir=httpuv:::.globals)
  if (is.null(wrapper)) {
    if (!is.null(msg$uuid)) {
      httpuv:::httpuv_write_tcp_response(
        msg$uuid,
        list(
          status = 503L,
          headers = list(\`Content-Type\` = "text/plain"),
          body = "httpuv: no server running"
        )
      )
    }
  } else {
    httpuv:::httpuv_handle_http_request(wrapper, msg)
  }
  invisible(TRUE)
})`;
    }

    case CHANNEL.WS_OPEN: {
      const reqPart = msg.req
        ? `jsonlite::fromJSON(${jsonForR(serializeReqForR(msg.req as Record<string, unknown>))}, simplifyVector=FALSE)`
        : "NULL";
      return `local({
  wrapper <- get("active_app_wrapper", envir=httpuv:::.globals)
  if (!is.null(wrapper)) {
    req <- ${reqPart}
    wrapper$onWSOpen(${jsonForR(msg.handle)}, httpuv:::httpuv_js_req_to_rook(req))
  }
  invisible(TRUE)
})`;
    }

    case CHANNEL.WS_MESSAGE: {
      const bytesJson = jsonForR(encodeWsPayloadBytes(msg.message, Boolean(msg.binary)));
      return `local({
  wrapper <- get("active_app_wrapper", envir=httpuv:::.globals)
  if (!is.null(wrapper)) {
    msg_raw <- httpuv:::httpuv_bytes_to_raw(
      jsonlite::fromJSON(${bytesJson}, simplifyVector=FALSE)
    )
    wrapper$onWSMessage(${jsonForR(msg.handle)}, TRUE, msg_raw)
  }
  invisible(TRUE)
})`;
    }

    case CHANNEL.WS_CLOSE:
      return `local({
  wrapper <- get("active_app_wrapper", envir=httpuv:::.globals)
  if (!is.null(wrapper)) {
    wrapper$onWSClose(${jsonForR(msg.handle)})
  }
  invisible(TRUE)
})`;

    default:
      throw new Error(`unsupported inbound channel message type: ${msg.type}`);
  }
}
