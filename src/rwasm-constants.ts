/** Message types between the main page and the R.wasm dedicated worker. */
export const RWASM = {
  INIT: "rwasm_init",
  READY: "rwasm_ready",
  EVAL: "rwasm_eval",
  EVAL_RESULT: "rwasm_eval_result",
  WRITE_WEB_APP: "rwasm_write_web_app",
  STOP_APP: "rwasm_stop_app",
  STOPPED: "rwasm_stopped",
  COMLINK_PORT: "rwasm_comlink_port",
  COMLINK_READY: "rwasm_comlink_ready",
  GET_RESOURCE_PATHS: "rwasm_get_resource_paths",
  RESOURCE_PATHS: "rwasm_resource_paths",
  LOG: "rwasm_log",
  ERROR: "rwasm_error",
} as const;
