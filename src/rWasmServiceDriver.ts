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
 * hidden). Delayed wakes use setTimeout then rAF so Chrome does not treat the
 * service loop as a chained timer poll
 * (https://developer.chrome.com/blog/timer-throttling-in-chrome-88/).
 */
export function createServiceDriver(): ServiceDriver {
  let worker: Worker | null = null;
  let rafPending = false;
  let rafId = 0;
  let tickInFlight = false;
  let wakeQueued = false;
  let stopped = true;
  const delayTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Absolute deadline (performance.now) of the soonest pending delay, or Infinity. */
  let delayDeadline = Infinity;

  function clearDelayTimers(): void {
    for (const id of delayTimers) {
      clearTimeout(id);
    }
    delayTimers.clear();
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
    if (!worker || stopped || tickInFlight) {
      if (!tickInFlight) {
        wakeQueued = true;
      }
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
      return;
    }
    rafPending = true;
    rafId = requestAnimationFrame(onFrame);
  }

  /**
   * Immediate wake that does not wait for the next animation frame.
   * Chrome often defers parent-page rAF while focus is inside the Shiny iframe;
   * a 0ms timer still runs and is enough to post SERVICE_TICK.
   */
  function wakeSoon(): void {
    if (stopped || !worker) {
      return;
    }
    if (tickInFlight) {
      wakeQueued = true;
      return;
    }
    const id = setTimeout(() => {
      delayTimers.delete(id);
      postTick();
    }, 0);
    delayTimers.add(id);
  }

  function scheduleDelay(delayMs: number): void {
    if (stopped || !worker) {
      return;
    }
    const ms = Math.max(0, Number(delayMs) || 0);
    if (ms <= 0) {
      wakeSoon();
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
      // Break the timer chain: fire the actual wake on the next animation frame.
      requestAnimationFrame(() => {
        wake();
      });
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
        // Immediate follow-up: drop coalesced delays so we don't double-fire.
        clearDelayTimers();
        wake();
      }
      return;
    }

    if (data.type === RWASM.NEED_SERVICE) {
      // Prefer an immediate timer wake so Chrome does not wait on parent rAF
      // while the viewer iframe holds focus; also arm rAF as a backup pace.
      wakeSoon();
      wake();
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
      wake();
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
    wake();
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
