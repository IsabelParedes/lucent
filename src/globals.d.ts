import type { HttpuvModule } from "./httpuv/types";

export {};

declare global {
  /** Set by enableHttpuvDebug() / ?httpuvDebug=1 */
  // eslint-disable-next-line no-var
  var __HTTPUV_DEBUG__: boolean | undefined;

  /** Live Rmain instance (set by Lucent after init) for the httpuv bridge. */
  // eslint-disable-next-line no-var
  var Module:
    | {
        httpuv?: HttpuvModule;
        _rWasmEvalDepth?: number;
        [key: string]: unknown;
      }
    | undefined;

  // eslint-disable-next-line no-var
  var Shiny:
    | {
        createSocket?: () => unknown;
        [key: string]: unknown;
      }
    | undefined;
}
