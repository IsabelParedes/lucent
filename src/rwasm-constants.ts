/** R_HOME inside the mounted prefix (VFS root is /). */
export const WASM_R_HOME = "/lib/R";

/** App directory inside the R VFS (populated via empack pack dir + append). */
export const WEB_APP_DIR = "/webApp";

/** Message types between the main page and the R.wasm dedicated worker. */
export const RWASM = {
  READY: "rwasm_ready",
  EVAL: "rwasm_eval",
  EVAL_RESULT: "rwasm_eval_result",
  STOP_APP: "rwasm_stop_app",
  REMOUNT_R_HOME: "rwasm_remount_r_home",
  STOPPED: "rwasm_stopped",
  COMLINK_PORT: "rwasm_comlink_port",
  COMLINK_READY: "rwasm_comlink_ready",
  GET_RESOURCE_PATHS: "rwasm_get_resource_paths",
  RESOURCE_PATHS: "rwasm_resource_paths",
  LOG: "rwasm_log",
  /** Worker → main: empack package download progress. */
  DOWNLOAD_PROGRESS: "rwasm_download_progress",
  /** Worker → main: coarse boot phase updates after / around downloads. */
  BOOT_STATUS: "rwasm_boot_status",
  ERROR: "rwasm_error",
  /** Main → worker: run one shiny::serviceOnce tick. */
  SERVICE_TICK: "rwasm_service_tick",
  /** Worker → main: result of a SERVICE_TICK (`hadWork` / `nextDelayMs`). */
  SERVICE_STATUS: "rwasm_service_status",
  /** Worker → main: schedule an immediate MessageChannel wake. */
  NEED_SERVICE: "rwasm_need_service",
  /** Worker → main: delayed wake (`delayMs`) via setTimeout then MessageChannel.
   * Used when scheduleTask runs outside a SERVICE_TICK; idle delays after a tick
   * go through SERVICE_STATUS.nextDelayMs instead. */
  SCHEDULE_DELAY: "rwasm_schedule_delay",
} as const;
