/** Host directory name under the site root where the wasm prefix is served. */
export const HOST_PREFIX = "_env-wasm";

/** R_HOME inside the mounted prefix (VFS root is /). */
export const WASM_R_HOME = "/lib/R";

/** App directory inside the R VFS (written by Lucent before startApp). */
export const WEB_APP_DIR = "/webApp";

/** Message types between the main page and the R.wasm dedicated worker. */
export const RWASM = {
  READY: "rwasm_ready",
  EVAL: "rwasm_eval",
  EVAL_RESULT: "rwasm_eval_result",
  WRITE_WEB_APP_FILES: "rwasm_write_web_app_files",
  STOP_APP: "rwasm_stop_app",
  REMOUNT_R_HOME: "rwasm_remount_r_home",
  STOPPED: "rwasm_stopped",
  COMLINK_PORT: "rwasm_comlink_port",
  COMLINK_READY: "rwasm_comlink_ready",
  GET_RESOURCE_PATHS: "rwasm_get_resource_paths",
  RESOURCE_PATHS: "rwasm_resource_paths",
  LOG: "rwasm_log",
  ERROR: "rwasm_error",
} as const;
