/**
 * Opt-in tracing for Lucent / wasm Shiny (same switches as r-httpuv).
 *
 * Enable with either:
 *   - URL query: ?httpuvDebug=1
 *   - localStorage: shinyForgeDebug = "1"
 *   - console: shinyForge.enableHttpuvDebug()
 */
export function isLucentDebug(): boolean {
  if (globalThis.__HTTPUV_DEBUG__) {
    return true;
  }
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("shinyForgeDebug") === "1") {
      return true;
    }
    const loc =
      typeof location !== "undefined"
        ? location
        : typeof self !== "undefined" && "location" in self
          ? (self as WorkerGlobalScope).location
          : undefined;
    if (loc?.href) {
      const params = new URL(loc.href).searchParams;
      if (params.has("httpuvDebug") || params.get("debug") === "httpuv") {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

/** Structured trace — only when debug is enabled. */
export function lucentDebugLog(stage: string, ...args: unknown[]): void {
  if (!isLucentDebug()) {
    return;
  }
  console.info(`[lucent-debug:${stage}]`, ...args);
}

/** One-shot informational log — only when debug is enabled. */
export function lucentInfo(...args: unknown[]): void {
  if (!isLucentDebug()) {
    return;
  }
  console.info(...args);
}

/** R worker log relay: always forwarded to the console. */
export function forwardRWorkerLog(level: "log" | "error", text: string): void {
  if (level === "error") {
    console.error(`[rWasmWorker] ${text}`);
    return;
  }
  console.log(`[rWasmWorker] ${text}`);
}
