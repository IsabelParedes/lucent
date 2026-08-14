let shinyPrefix: string | null = null;

/**
 * Resolve the virtual Shiny app prefix from a module script URL.
 * e.g. /site/runApp.js -> /site/shiny/
 */
export function resolveShinyPrefix(fromUrl: string | URL): string {
  const prefix = new URL("shiny/", fromUrl).pathname;
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

export function setShinyPrefix(prefix: string): void {
  shinyPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
}

export function getShinyPrefix(): string {
  if (!shinyPrefix) {
    throw new Error("Shiny prefix not initialized");
  }
  return shinyPrefix;
}

/** Session directory name under the Shiny virtual app prefix. */
export const SESSION_DIR = "__session__";

/** Host -> SW outbound path (fetch fallback when controller.postMessage unavailable). */
export const HOST_DIR = "__host__";

export interface SessionAction {
  action: string;
  handle: string | null;
}

/**
 * Strip accidental JSON quoting from session handles (R/Comlink sometimes
 * double-encode UUID strings).
 */
export function normalizeSessionHandle(handle: unknown): string {
  let s = String(handle ?? "").trim();
  while (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
  }
  return s;
}

export function resolveSessionPrefix(fromUrl: string | URL): string {
  return `${resolveShinyPrefix(fromUrl)}${SESSION_DIR}/`;
}

export function getSessionPrefix(): string {
  return `${getShinyPrefix()}${SESSION_DIR}/`;
}

export function parseSessionAction(urlString: string, prefix: string): SessionAction | null {
  const url = new URL(urlString);
  const sessionPrefix = `${prefix}${SESSION_DIR}/`;
  if (!url.pathname.startsWith(sessionPrefix)) {
    return null;
  }
  const action = url.pathname.slice(sessionPrefix.length).replace(/\/$/, "");
  if (!["open", "send", "recv", "close"].includes(action)) {
    return null;
  }
  const rawHandle = url.searchParams.get("handle");
  return {
    action,
    handle: rawHandle ? normalizeSessionHandle(rawHandle) : null,
  };
}

/** Session HTTP actions handled by the R worker (not SW MessagePort delivery). */
export function isSessionHttpRequest(urlString: string, prefix?: string): boolean {
  if (prefix) {
    const session = parseSessionAction(urlString, prefix);
    return session !== null && session.action !== "recv";
  }
  return /\/__session__\/(open|send|close)(?:\?|$|\/)/.test(urlString);
}

export function isHostPushUrl(urlString: string, prefix: string): boolean {
  const url = new URL(urlString);
  return url.pathname === `${prefix}${HOST_DIR}/push`;
}

/**
 * Build a same-origin URL under the Shiny virtual app prefix.
 * @param fromUrl defaults to this module's location when called from the main page
 */
export function shinyAppUrl(subpath = "", fromUrl: string | URL = import.meta.url): string {
  const base = new URL("shiny/", fromUrl);
  return new URL(subpath.replace(/^\//, ""), base).href;
}
