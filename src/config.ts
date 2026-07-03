export interface LucentConfig {
  /** Base URL where the r-httpuv transport assets are served. */
  transportBaseUrl: string;
}

/** Default location of the transport assets once r-httpuv is installed into R_HOME. */
export const DEFAULT_TRANSPORT_BASE_URL = "/R_HOME/library/httpuv/www/";

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
  };
}
