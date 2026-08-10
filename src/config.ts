export interface LucentConfig {
  /** Base URL where Lucent-built httpuv transport assets (httpuv-web.js, shiny-socket.js, ...) are served. */
  transportBaseUrl: string;
  /**
   * URL of the httpuv service worker script. Defaults to `/httpuv-sw.js` at the
   * site root so registration works on hosts that cannot send
   * `Service-Worker-Allowed` (e.g. GitHub Pages). That file is a deploy-time
   * or serve-time alias of `lucent/dist/httpuv-sw.js`.
   */
  serviceWorkerUrl: string;
  /**
   * Base URL for the Rmain bootstrap binaries (`bin/Rmain.js`, `bin/Rmain.wasm`).
   * Trailing slash is normalized at use sites.
   */
  rRuntimeBaseUrl: string;
  /** URL of `empack_env_meta.json` (packages + appended webApp archive). */
  empackMetaUrl: string;
  /** Base URL for empack package archives listed in the meta file. */
  empackPackagesBaseUrl: string;
  /**
   * Base URL under which the virtual Shiny app is mounted; the mount prefix is
   * `<shinyBaseUrl>shiny/`. Defaults to the origin root ("/"), giving `/shiny/`.
   * This MUST be decoupled from where the JS bundles live (e.g. /lucent/dist/),
   * otherwise Shiny's asset URLs collide with the real bundle directory.
   */
  shinyBaseUrl: string;
}

/** Default location of Lucent-built httpuv transport assets. */
export const DEFAULT_TRANSPORT_BASE_URL = "/lucent/dist/";

/** Default SW script URL (site root alias of lucent/dist/httpuv-sw.js). */
export const DEFAULT_SERVICE_WORKER_URL = "/httpuv-sw.js";

/** Default base for Rmain.js / Rmain.wasm (`bin/` under this URL). */
export const DEFAULT_R_RUNTIME_BASE_URL = "/runtime/";

/** Default empack meta URL. */
export const DEFAULT_EMPACK_META_URL = "/packages/empack_env_meta.json";

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

function resolveAgainstLocation(url: string): URL {
  const base =
    typeof self !== "undefined" && self.location?.href
      ? self.location.href
      : "http://localhost/";
  return new URL(url, base);
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

  const empackMetaUrl = pick("empackMetaUrl") ?? DEFAULT_EMPACK_META_URL;
  const empackPackagesBaseUrl =
    pick("empackPackagesBaseUrl") ?? new URL(".", resolveAgainstLocation(empackMetaUrl)).href;

  return {
    transportBaseUrl: pick("transportBaseUrl") ?? DEFAULT_TRANSPORT_BASE_URL,
    serviceWorkerUrl: pick("serviceWorkerUrl") ?? DEFAULT_SERVICE_WORKER_URL,
    rRuntimeBaseUrl: pick("rRuntimeBaseUrl") ?? DEFAULT_R_RUNTIME_BASE_URL,
    empackMetaUrl,
    empackPackagesBaseUrl,
    shinyBaseUrl: pick("shinyBaseUrl") ?? DEFAULT_SHINY_BASE_URL,
  };
}
