import { RWASM } from "./rwasm-constants";

export type ServiceDriver = {
  /** Ensure an rAF tick is scheduled (idempotent; visible tabs only). */
  wake: () => void;
  /** Schedule a delayed wake via setTimeout → MessageChannel (breaks chained-timer loops). */
  scheduleDelay: (delayMs: number) => void;
  /** Attach to a worker; replaces any previous attachment. */
  attach: (worker: Worker) => void;
  /** Detach listeners and cancel pending frames/timers. */
  stop: () => void;
};

export type ServiceDriverOptions = {
  /** Called when a SERVICE_TICK reported reactive/HTTP work. */
  onHadWork?: () => void;
};

type ServiceStatusMessage = {
  type: typeof RWASM.SERVICE_STATUS;
  hadWork?: boolean;
  /** Ms until next R timer, or -1 / omitted when idle. */
  nextDelayMs?: number;
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
 * Immediate follow-ups use a MessageChannel macrotask so Chrome does not
 * throttle nested setTimeout(0) chains while DevTools is open or focus is
 * inside the Shiny iframe. requestAnimationFrame only coalesces visible work
 * (it pauses when the tab is hidden).
 */
export function createServiceDriver(options: ServiceDriverOptions = {}): ServiceDriver {
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

  // MessageChannel macrotasks avoid nested-setTimeout clamping / DevTools deferral
  // (same approach as rWasmTasks.ts on the worker).
  const soonChannel = new MessageChannel();
  soonChannel.port1.onmessage = () => {
    if (!soonPending) {
      // Cancelled by clearSoon / stop / scheduleDelay coalescing.
      return;
    }
    soonPending = false;
    if (stopped || !worker) {
      return;
    }
    postTick();
  };

  function clearSoon(): void {
    soonPending = false;
  }

  /** Cancel pending setTimeout delays only (leave MessageChannel wakes alone). */
  function clearDelayOnly(): void {
    for (const id of delayTimers) {
      clearTimeout(id);
    }
    delayTimers.clear();
    delayDeadline = Infinity;
  }

  function clearDelayTimers(): void {
    clearDelayOnly();
    clearSoon();
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
    // rAF is paused while the tab is hidden; MessageChannel covers that case.
    if (document.visibilityState !== "visible") {
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
   * Uses MessageChannel instead of setTimeout(0) so Chrome does not clamp
   * chained timers when DevTools is open or the Shiny iframe has focus.
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
    soonChannel.port2.postMessage(0);
  }

  /** Schedule an immediate service tick; MessageChannel first, rAF as visible backup. */
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
    clearDelayOnly();
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
      const status = data as ServiceStatusMessage;
      const hadWork = Boolean(status.hadWork);
      const nextDelayMs = Number(status.nextDelayMs);
      if (stopped) {
        return;
      }
      if (hadWork || wakeQueued) {
        if (hadWork) {
          options.onHadWork?.();
        }
        wakeQueued = false;
        scheduleFollowUp();
        return;
      }
      // Host owns the post-tick delay timer (R no longer scheduleHostDelay from serviceOnce).
      if (Number.isFinite(nextDelayMs) && nextDelayMs >= 0) {
        scheduleDelay(nextDelayMs);
      } else {
        // Idle or cancelled timers: drop any stale delay (keep MessageChannel wakes).
        clearDelayOnly();
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

  /**
   * Attaching does not tick. A tick is a synchronous R call, and until the app
   * is started there is nothing to service, so the first tick is left to R
   * (NEED_SERVICE) or to the explicit wake() after startApp. Ticking on attach
   * put a long R call in front of the boot-time Comlink handshake.
   */
  function attach(next: Worker): void {
    if (worker === next && !stopped) {
      return;
    }
    stop();
    worker = next;
    stopped = false;
    worker.addEventListener("message", onWorkerMessage);
    document.addEventListener("visibilitychange", onVisibilityChange);
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
