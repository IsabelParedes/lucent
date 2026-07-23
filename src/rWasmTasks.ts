import { evalR, type RModule } from "./rWasmBootstrap";
import type { HttpuvTransport } from "./transport";

/** Thin R wrappers around shiny:: host-control APIs. */
export const SHINY_HOST = {
  stop: `tryCatch({
  if (requireNamespace("shiny", quietly=TRUE) && shiny::isRunning()) {
    shiny::stopApp()
  }
}, error=function(e) NULL)`,
  suspend: `tryCatch(shiny::suspendServiceLoop(), error=function(e) NULL)`,
  resume: `tryCatch(shiny::resumeServiceLoop(), error=function(e) NULL)`,
  serviceOnce: `tryCatch(shiny::serviceOnce(), error=function(e) NULL)`,
} as const;

export type TaskRuntime = {
  getModule: () => RModule | null;
  getTransport: () => HttpuvTransport | null;
};

interface RTask {
  work: () => void;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export type RTaskQueue = {
  scheduleMacrotask: (cb: () => void) => void;
  enqueueRTask: (work: () => void) => Promise<void>;
  evalRNow: (code: string) => void;
  isRLocked: () => boolean;
  hasPendingRTasks: () => boolean;
};

/**
 * Macrotask scheduler + serialized evalR queue.
 * MessageChannel turns avoid nested-setTimeout clamping and background throttling.
 */
export function createRTaskQueue(rt: TaskRuntime): RTaskQueue {
  const macrotaskChannel = new MessageChannel();
  const macrotaskQueue: Array<() => void> = [];
  macrotaskChannel.port1.onmessage = () => {
    const cb = macrotaskQueue.shift();
    if (cb) {
      cb();
    }
  };

  function scheduleMacrotask(cb: () => void): void {
    macrotaskQueue.push(cb);
    macrotaskChannel.port2.postMessage(0);
  }

  const rTaskQueue: RTask[] = [];
  let rDrainScheduled = false;
  let rLocked = false;

  function scheduleRDrain(): void {
    if (rDrainScheduled) {
      return;
    }
    rDrainScheduled = true;
    scheduleMacrotask(drainRTaskQueue);
  }

  function drainRTaskQueue(): void {
    rDrainScheduled = false;
    if (!rt.getModule() || rTaskQueue.length === 0) {
      return;
    }

    const task = rTaskQueue.shift();
    if (!task) {
      return;
    }
    rLocked = true;
    try {
      task.work();
      task.resolve();
    } catch (err) {
      task.reject(err);
    } finally {
      rLocked = false;
      rt.getTransport()?.flushDeferredOutbound();
    }

    if (rTaskQueue.length > 0) {
      scheduleRDrain();
    }
  }

  function enqueueRTask(work: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      rTaskQueue.push({ work, resolve, reject });
      scheduleRDrain();
    });
  }

  function evalRNow(code: string): void {
    const module = rt.getModule();
    if (!module) {
      throw new Error("[lucent] R module not initialized yet");
    }
    evalR(module, code);
  }

  return {
    scheduleMacrotask,
    enqueueRTask,
    evalRNow,
    isRLocked: () => rLocked,
    hasPendingRTasks: () => rTaskQueue.length > 0,
  };
}
