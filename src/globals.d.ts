export {};

declare global {
  /** Live Rmain instance (set by Lucent after init) for the httpuv bridge. */
  // eslint-disable-next-line no-var
  var Module:
    | {
        httpuv?: unknown;
        _rWasmEvalDepth?: number;
        [key: string]: unknown;
      }
    | undefined;
}
