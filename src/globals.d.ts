export {};

declare global {
  /**
   * The Emscripten R.wasm module object. It is created and populated by the
   * generated glue code, so it is intentionally loosely typed here.
   */
  // eslint-disable-next-line no-var
  var Module: any;
}
