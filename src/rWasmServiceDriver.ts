import { RWASM } from "./rwasm-constants";

export type ServiceDriver = {
  /** Ensure an rAF tick is scheduled (idempotent). */
  wake: () => void;
  /** Schedule a delayed wake via setTimeout → rAF (breaks chained-timer loops). */
  scheduleDelay: (delayMs: number) => void;
  /** Attach to a worker; replaces any previous attachment. */
  attach: (worker: Worker) => void;
  /** Detach listeners and cancel pending frames/timers. */
  stop: () => void;
};

type ServiceStatusMessage = {
  type: typeof RWASM.SERVICE_STATUS;
  hadWork?: boolean;
};

type NeedServiceMessage = {
  type: typeof RWASM.NEED_SERVICE;
};

type ScheduleDelayMessage = {
  type: typeof RWASM.SCHEDULE_DELAY;
  delayMs?: number;
};

/**
 * Main-thread Shiny service driver.
 *
 * Visible work is paced with requestAnimationFrame (pauses when the tab is
 * hidden). Immediate follow-ups prefer setTimeout(0) so Chrome does not defer
 * ticks while DevTools is open or focus is inside the Shiny iframe.
 */
export function createServiceDriver(): ServiceDriver {
  let worker: Worker | null = null;
  let rafPending = false;
  let rafId = 0;
  let tickInFlight = false;
  let wakeQueued = false;
  let soonPending = false;
  let stopped = true;
  const delayTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Absolute deadline (performance.now) of the soonest pending delay, or Infinity. */
  let delayDeadline = Infinity;

  function clearDelayTimers(): void {
    for (const id of delayTimers) {
      clearTimeout(id);
    }
    delayTimers.clear();
    soonPending = false;
    delayDeadline = Infinity;
  }

  function cancelRaf(): void {
    if (rafPending && rafId) {
      cancelAnimationFrame(rafId);
    }
    rafPending = false;
    rafId = 0;
  }

  function postTick(): void {
    if (!worker || stopped) {
      return;
    }
    if (tickInFlight) {
      wakeQueued = true;
      return;
    }
    tickInFlight = true;
    wakeQueued = false;
    worker.postMessage({ type: RWASM.SERVICE_TICK });
  }

  function onFrame(): void {
    rafPending = false;
    rafId = 0;
    if (stopped || !worker) {
      return;
    }
    postTick();
  }

  function wake(): void {
    if (stopped || !worker) {
      return;
    }
    if (tickInFlight) {
      wakeQueued = true;
      return;
    }
    if (rafPending) {
      wakeQueued = true;
      return;
    }
    rafPending = true;
    rafId = requestAnimationFrame(onFrame);
  }

  /**
   * Immediate wake that does not wait for the next animation frame.
   * Chrome often defers parent-page rAF while focus is inside the Shiny iframe
   * or while DevTools is open; a 0ms timer still runs promptly enough.
   */
  function wakeSoon(): void {
    if (stopped || !worker) {
      return;
    }
    if (tickInFlight) {
      wakeQueued = true;
      return;
    }
    if (soonPending) {
      wakeQueued = true;
      return;
    }
    soonPending = true;
    const id = setTimeout(() => {
      delayTimers.delete(id);
      soonPending = false;
      postTick();
    }, 0);
    delayTimers.add(id);
  }

  /** Schedule an immediate service tick; timer first, rAF as backup. */
  function scheduleFollowUp(): void {
    wakeSoon();
    wake();
  }

  function scheduleDelay(delayMs: number): void {
    if (stopped || !worker) {
      return;
    }
    const ms = Math.max(0, Number(delayMs) || 0);
    if (ms <= 0) {
      scheduleFollowUp();
      return;
    }
    const deadline = performance.now() + ms;
    // Keep only the soonest wake; ignore later requests.
    if (deadline >= delayDeadline) {
      return;
    }
    clearDelayTimers();
    delayDeadline = deadline;
    const id = setTimeout(() => {
      delayTimers.delete(id);
      delayDeadline = Infinity;
      scheduleFollowUp();
    }, ms);
    delayTimers.add(id);
  }

  function onWorkerMessage(event: MessageEvent): void {
    const data = event.data as
      | ServiceStatusMessage
      | NeedServiceMessage
      | ScheduleDelayMessage
      | undefined;
    if (!data || typeof data.type !== "string") {
      return;
    }

    if (data.type === RWASM.SERVICE_STATUS) {
      tickInFlight = false;
      const hadWork = Boolean((data as ServiceStatusMessage).hadWork);
      if (stopped) {
        return;
      }
      if (hadWork || wakeQueued) {
        wakeQueued = false;
        scheduleFollowUp();
      }
      return;
    }

    if (data.type === RWASM.NEED_SERVICE) {
      scheduleFollowUp();
      return;
    }

    if (data.type === RWASM.SCHEDULE_DELAY) {
      scheduleDelay(Number((data as ScheduleDelayMessage).delayMs) || 0);
    }
  }

  function onVisibilityChange(): void {
    if (stopped) {
      return;
    }
    if (document.visibilityState === "visible") {
      scheduleFollowUp();
    }
  }

  function attach(next: Worker): void {
    if (worker === next && !stopped) {
      return;
    }
    stop();
    worker = next;
    stopped = false;
    worker.addEventListener("message", onWorkerMessage);
    document.addEventListener("visibilitychange", onVisibilityChange);
    scheduleFollowUp();
  }

  function stop(): void {
    stopped = true;
    tickInFlight = false;
    wakeQueued = false;
    cancelRaf();
    clearDelayTimers();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (worker) {
      worker.removeEventListener("message", onWorkerMessage);
    }
    worker = null;
  }

  return { wake, scheduleDelay, attach, stop };
}
