/**
 * Opt-in tracing for the httpuv / Shiny-Forge request pipeline.
 *
 * Enable with either:
 *   - URL query: ?httpuvDebug=1
 *   - localStorage: localStorage.shinyForgeDebug = "1"
 *   - console: shinyForge.enableHttpuvDebug()
 */
export function isHttpuvDebug(): boolean {
  if (globalThis.__HTTPUV_DEBUG__) {
    return true;
  }
  try {
    if (typeof location !== "undefined") {
      const params = new URLSearchParams(location.search);
      if (params.has("httpuvDebug") || params.get("debug") === "httpuv") {
        return true;
      }
    }
    if (typeof localStorage !== "undefined" && localStorage.getItem("shinyForgeDebug") === "1") {
      return true;
    }
    if (typeof self !== "undefined" && self.location?.href) {
      const params = new URL(self.location.href).searchParams;
      if (params.has("httpuvDebug") || params.get("debug") === "httpuv") {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

export function httpuvDebugLog(stage: string, ...args: unknown[]): void {
  if (!isHttpuvDebug()) {
    return;
  }
  console.info(`[httpuv-debug:${stage}]`, ...args);
}

export function enableHttpuvDebug(): void {
  globalThis.__HTTPUV_DEBUG__ = true;
  try {
    localStorage.setItem("shinyForgeDebug", "1");
  } catch {
    // ignore
  }
  console.info(
    "[httpuv-debug] enabled - reload or run shinyForge.enableHttpuvDebug() then re-run app",
  );
}
