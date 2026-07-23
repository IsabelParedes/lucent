import type { RTaskQueue } from "./rWasmTasks";
import { SHINY_HOST } from "./rWasmTasks";
import type { RModule } from "./rWasmBootstrap";

/** Minimum spacing between idle service ticks (a real evalR is expensive). */
const PUMP_INTERVAL_MS = 16;

/** Keep the pump on the unthrottled macrotask loop this long after activity. */
const ACTIVE_WINDOW_MS = 2_000;

/** Idle-backoff cadence: once quiet, a plain timer is fine (nothing to pump). */
const IDLE_PUMP_MS = 96;

export type PumpDeps = {
  tasks: RTaskQueue;
  getModule: () => RModule | null;
  /** True while an HTTP request is mid-flight and the idle pump must pause. */
  isHttpDeliveryActive: () => boolean;
  /** True when HTTP work is queued or in flight (stay on macrotask loop). */
  hasHttpWork: () => boolean;
  formatError: (err: unknown) => string;
  dbg: (stage: string, ...args: unknown[]) => void;
};

export type LaterPump = {
  markActivity: () => void;
  ensureRLaterPump: () => void;
};

/**
 * Idle service pump. While there has been recent traffic it rides the
 * unthrottled macrotask loop; once quiet it backs off to a plain timer.
 */
export function createLaterPump(deps: PumpDeps): LaterPump {
  let pumpStarted = false;
  let pumpScheduled = false;
  let pumpViaMacrotask = false;
  let pumpTimer: ReturnType<typeof setTimeout> | null = null;
  let lastActivityTs = 0;
  let lastPumpTickTs = 0;

  function schedulePump(viaMacrotask: boolean, delayMs = 0): void {
    if (pumpScheduled) {
      return;
    }
    pumpScheduled = true;
    pumpViaMacrotask = viaMacrotask;
    if (viaMacrotask) {
      deps.tasks.scheduleMacrotask(() => {
        pumpScheduled = false;
        pumpOnce();
      });
    } else {
      pumpTimer = setTimeout(() => {
        pumpTimer = null;
        pumpScheduled = false;
        pumpOnce();
      }, delayMs);
    }
  }

  function pumpOnce(): void {
    if (!deps.getModule()) {
      return;
    }

    const now = Date.now();
    if (
      now - lastPumpTickTs >= PUMP_INTERVAL_MS &&
      !deps.tasks.isRLocked() &&
      !deps.tasks.hasPendingRTasks() &&
      !deps.isHttpDeliveryActive()
    ) {
      lastPumpTickTs = now;
      void deps.tasks
        .enqueueRTask(() => {
          deps.tasks.evalRNow(SHINY_HOST.serviceOnce);
        })
        .catch((err) => {
          console.warn("[rWasmWorker] later pump failed:", deps.formatError(err));
        });
    }

    const active =
      now - lastActivityTs < ACTIVE_WINDOW_MS || deps.hasHttpWork();
    schedulePump(active, active ? 0 : IDLE_PUMP_MS);
  }

  function markActivity(): void {
    lastActivityTs = Date.now();
    if (pumpStarted && !pumpViaMacrotask && pumpTimer !== null) {
      clearTimeout(pumpTimer);
      pumpTimer = null;
      pumpScheduled = false;
      schedulePump(true, 0);
    }
  }

  function ensureRLaterPump(): void {
    if (pumpStarted) {
      return;
    }
    pumpStarted = true;
    lastActivityTs = Date.now();
    schedulePump(true, 0);
    deps.dbg("later-pump", { intervalMs: PUMP_INTERVAL_MS, driver: "message-loop" });
  }

  return { markActivity, ensureRLaterPump };
}
