export interface LucentConfig {
  /** Base URL where the r-httpuv transport assets (httpuv-web.js, httpuv-sw.js, ...) are served. */
  transportBaseUrl: string;
  /** Base URL where the R.wasm runtime (R, R.wasm, R_HOME/, R_HOME-manifest.json) is served. */
  rRuntimeBaseUrl: string;
  /**
   * Base URL under which the virtual Shiny app is mounted; the mount prefix is
   * `<shinyBaseUrl>shiny/`. Defaults to the origin root ("/"), giving `/shiny/`.
   * This MUST be decoupled from where the JS bundles live (e.g. /lucent/dist/),
   * otherwise Shiny's asset URLs collide with the real bundle directory.
   */
  shinyBaseUrl: string;
  /** Base URL of the Shiny app directory. Defaults to `webApp/` relative to the page. */
  appDirUrl?: string;
  /** URL of the app file manifest ({ files: string[] }). Defaults to `manifest.json` under appDirUrl. */
  appManifestUrl?: string;
}

/** Default location of the transport assets once r-httpuv is installed into R_HOME. */
export const DEFAULT_TRANSPORT_BASE_URL = "/R_HOME/library/httpuv/www/";

/** Default location of the R.wasm runtime assets (currently the site root). */
export const DEFAULT_R_RUNTIME_BASE_URL = "/";

/** Default base for the Shiny mount point (origin root → prefix `/shiny/`). */
export const DEFAULT_SHINY_BASE_URL = "/";

interface LucentGlobal {
  __LUCENT__?: Partial<LucentConfig>;
}

/** URL query param the host uses to hand its resolved config to the worker. */
export const LUCENT_CONFIG_PARAM = "lucentConfig";

/**
 * Read config overrides serialized onto this context's own URL
 * (`?lucentConfig=<json>`). The host is the single source of truth: it resolves
 * config once and passes it to the worker via this param, so the worker does
 * not re-resolve from its own (empty) globalThis.
 */
function configOverridesFromUrl(): Partial<LucentConfig> {
  try {
    const search = (globalThis as unknown as { location?: { search?: string } }).location?.search;
    if (!search) {
      return {};
    }
    const raw = new URLSearchParams(search).get(LUCENT_CONFIG_PARAM);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Partial<LucentConfig>;
    }
  } catch {
    // ignore malformed config; fall back to globals/defaults
  }
  return {};
}

/**
 * Resolve the runtime config, layering explicit overrides over a `?lucentConfig`
 * URL param (host → worker handoff) over a globalThis (`__LUCENT__`) config over
 * the built-in defaults.
 */
export function resolveLucentConfig(overrides: Partial<LucentConfig> = {}): LucentConfig {
  const fromGlobal = (globalThis as unknown as LucentGlobal).__LUCENT__ ?? {};
  const fromUrl = configOverridesFromUrl();
  const pick = <K extends keyof LucentConfig>(key: K): LucentConfig[K] | undefined =>
    overrides[key] ?? fromUrl[key] ?? fromGlobal[key];
  return {
    transportBaseUrl: pick("transportBaseUrl") ?? DEFAULT_TRANSPORT_BASE_URL,
    rRuntimeBaseUrl: pick("rRuntimeBaseUrl") ?? DEFAULT_R_RUNTIME_BASE_URL,
    shinyBaseUrl: pick("shinyBaseUrl") ?? DEFAULT_SHINY_BASE_URL,
    appDirUrl: pick("appDirUrl"),
    appManifestUrl: pick("appManifestUrl"),
  };
}
