export interface LucentConfig {
  /** Base URL where the r-httpuv transport assets (httpuv-web.js, httpuv-sw.js, ...) are served. */
  transportBaseUrl: string;
  /** Base URL where the R.wasm runtime (R, R.wasm, R_HOME/, R_HOME-manifest.json) is served. */
  rRuntimeBaseUrl: string;
  /** URL of the Shiny app source (app.R). Defaults to `webApp/app.R` relative to the page. */
  appSourceUrl?: string;
}

/** Default location of the transport assets once r-httpuv is installed into R_HOME. */
export const DEFAULT_TRANSPORT_BASE_URL = "/R_HOME/library/httpuv/www/";

/** Default location of the R.wasm runtime assets (currently the site root). */
export const DEFAULT_R_RUNTIME_BASE_URL = "/";

interface LucentGlobal {
  __LUCENT__?: Partial<LucentConfig>;
}

/**
 * Resolve the runtime config, layering explicit overrides over a globalThis
 * (`__LUCENT__`) config over the built-in defaults.
 */
export function resolveLucentConfig(overrides: Partial<LucentConfig> = {}): LucentConfig {
  const fromGlobal = (globalThis as unknown as LucentGlobal).__LUCENT__ ?? {};
  return {
    transportBaseUrl:
      overrides.transportBaseUrl ?? fromGlobal.transportBaseUrl ?? DEFAULT_TRANSPORT_BASE_URL,
    rRuntimeBaseUrl:
      overrides.rRuntimeBaseUrl ?? fromGlobal.rRuntimeBaseUrl ?? DEFAULT_R_RUNTIME_BASE_URL,
    appSourceUrl: overrides.appSourceUrl ?? fromGlobal.appSourceUrl,
  };
}
