import type { RModule } from "./rWasmBootstrap";
import { SHINY_HOST, type RTaskQueue } from "./rWasmTasks";
import type { HttpuvTransport } from "./transport";
import type { HostInboundMessage } from "./wiring";

/** Service rounds after push idle wait (promise resolution only). */
const HTTP_PUSH_DRAIN_ROUNDS = 128;

/** Poll interval while waiting for emscripten later timers (no evalR). */
const HTTP_IDLE_POLL_MS = 16;

/** Yield between drain rounds so emscripten later timers can fire. */
const HTTP_DRAIN_YIELD_MS = 4;

interface HttpDeliveryItem {
  req: HostInboundMessage;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export type HttpDeliveryDeps = {
  tasks: RTaskQueue;
  getModule: () => RModule | null;
  requireTransport: () => HttpuvTransport;
  markActivity: () => void;
  dbg: (stage: string, ...args: unknown[]) => void;
  formatError: (err: unknown) => string;
  logError: (err: unknown, url?: string) => void;
};

export type HttpDelivery = {
  setIdleMaxMs: (ms: number) => void;
  isHttpDeliveryActive: () => boolean;
  hasHttpWork: () => boolean;
  noteHttpResponse: (uuid: string | undefined) => void;
  enqueueHttpDelivery: (req: HostInboundMessage) => Promise<void>;
};

export function createHttpDelivery(deps: HttpDeliveryDeps): HttpDelivery {
  let httpIdleMaxMs = 30_000;
  let httpDeliveryActive = false;
  let httpDeliveryDraining = false;
  let shinyLoopSuspended = false;
  let httpDeliveryInflight = 0;
  let activeHttpDrainUuid: string | null = null;

  const httpDeliveryQueue: HttpDeliveryItem[] = [];
  const httpDrainByUuid = new Map<string, { resolved: boolean }>();

  function yieldMs(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async function idleWaitForHttpResponse(
    state: { resolved: boolean },
    uuid: string,
    maxMs = httpIdleMaxMs,
  ): Promise<void> {
    const start = Date.now();
    while (!state.resolved && Date.now() - start < maxMs) {
      await yieldMs(HTTP_IDLE_POLL_MS);
    }
    deps.dbg("worker-push-idle-done", {
      uuid,
      resolved: state.resolved,
      waitedMs: Date.now() - start,
    });
  }

  function isStaticAssetUrl(url: string): boolean {
    return deps.requireTransport().isLikelyStaticAsset(url);
  }

  function isSessionHttpUrl(url: string): boolean {
    const t = deps.requireTransport();
    try {
      return t.isSessionHttpRequest(url, t.getShinyPrefix());
    } catch {
      return t.isSessionHttpRequest(url);
    }
  }

  async function ensureShinyLoopSuspended(): Promise<void> {
    if (shinyLoopSuspended || !deps.getModule()) {
      return;
    }
    await deps.tasks.enqueueRTask(() => {
      deps.tasks.evalRNow(SHINY_HOST.suspend);
    });
    shinyLoopSuspended = true;
    deps.dbg("worker-shiny-loop-suspend", {});
  }

  async function ensureShinyLoopResumed(): Promise<void> {
    if (!shinyLoopSuspended || !deps.getModule()) {
      return;
    }
    await deps.tasks.enqueueRTask(() => {
      deps.tasks.evalRNow(SHINY_HOST.resume);
    });
    shinyLoopSuspended = false;
    deps.dbg("worker-shiny-loop-resume", {});
  }

  async function maybeFinishHttpDeliveryBatch(): Promise<void> {
    if (httpDeliveryQueue.length > 0 || httpDeliveryInflight > 0) {
      return;
    }
    await ensureShinyLoopResumed();
    httpDeliveryActive = false;
    httpDeliveryDraining = false;
  }

  function drainAfterHttpPush(
    roundsLeft: number,
    uuid: string,
    state: { resolved: boolean },
  ): Promise<void> {
    if (roundsLeft <= 0 || !deps.getModule() || state.resolved) {
      if (!state.resolved) {
        deps.dbg("worker-push-drain-exhausted", { uuid, roundsLeft });
      }
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      deps.tasks.scheduleMacrotask(() => {
        void deps.tasks
          .enqueueRTask(() => {
            deps.tasks.evalRNow(SHINY_HOST.serviceOnce);
          })
          .then(() => drainAfterHttpPush(roundsLeft - 1, uuid, state))
          .then(resolve);
      });
    });
  }

  async function deliverOneHttpRequest(req: HostInboundMessage): Promise<void> {
    const uuid = req.uuid ?? "";
    const url = req.url ?? "";
    const state = { resolved: false };
    httpDrainByUuid.set(uuid, state);
    httpDeliveryInflight++;
    activeHttpDrainUuid = uuid;

    const staticAsset = isStaticAssetUrl(url);
    const sessionHttp = isSessionHttpUrl(url);

    try {
      await deps.tasks.enqueueRTask(() => {
        deps.requireTransport().pushInboundHostMessage(req);
      });

      if (!staticAsset) {
        await idleWaitForHttpResponse(state, uuid, httpIdleMaxMs);

        if (!state.resolved) {
          await drainAfterHttpPush(HTTP_PUSH_DRAIN_ROUNDS, uuid, state);
        } else if (sessionHttp) {
          deps.dbg("worker-session-drain", { uuid });
          await drainAfterHttpPush(HTTP_PUSH_DRAIN_ROUNDS, uuid, { resolved: false });
        }
      } else if (!state.resolved) {
        await yieldMs(HTTP_DRAIN_YIELD_MS);
      }
    } finally {
      httpDrainByUuid.delete(uuid);
      if (activeHttpDrainUuid === uuid) {
        activeHttpDrainUuid = null;
      }
      httpDeliveryInflight--;
    }
  }

  async function drainHttpDeliveryQueue(): Promise<void> {
    while (httpDeliveryQueue.length > 0) {
      const item = httpDeliveryQueue.shift();
      if (!item) {
        break;
      }
      const itemUrl = item.req.url ?? "";
      const needsSuspend = !isStaticAssetUrl(itemUrl) && !isSessionHttpUrl(itemUrl);
      if (needsSuspend && !shinyLoopSuspended) {
        await ensureShinyLoopSuspended();
      }
      if (needsSuspend) {
        httpDeliveryActive = true;
      }
      try {
        await deliverOneHttpRequest(item.req);
        item.resolve();
      } catch (err) {
        deps.logError(err, itemUrl);
        item.reject(err);
      } finally {
        if (needsSuspend) {
          httpDeliveryActive = false;
        }
      }
      const next = httpDeliveryQueue[0];
      const nextUrl = next?.req.url ?? "";
      const nextNeedsSuspend = Boolean(
        next && !isStaticAssetUrl(nextUrl) && !isSessionHttpUrl(nextUrl),
      );
      if (shinyLoopSuspended && !nextNeedsSuspend) {
        await ensureShinyLoopResumed();
      }
    }

    await maybeFinishHttpDeliveryBatch();

    if (httpDeliveryQueue.length > 0 && !httpDeliveryDraining) {
      httpDeliveryDraining = true;
      void drainHttpDeliveryQueue();
    }
  }

  function enqueueHttpDelivery(req: HostInboundMessage): Promise<void> {
    deps.markActivity();
    deps.dbg("worker-push", { uuid: req.uuid, method: req.method, url: req.url });

    return new Promise((resolve, reject) => {
      httpDeliveryQueue.push({ req, resolve, reject });
      if (!httpDeliveryDraining) {
        httpDeliveryDraining = true;
        void drainHttpDeliveryQueue().catch((err) => {
          httpDeliveryDraining = false;
          httpDeliveryActive = false;
          deps.logError(err);
        });
      }
    });
  }

  return {
    setIdleMaxMs(ms: number) {
      httpIdleMaxMs = ms;
    },
    isHttpDeliveryActive: () => httpDeliveryActive,
    hasHttpWork: () => httpDeliveryInflight > 0 || httpDeliveryQueue.length > 0,
    noteHttpResponse(uuid: string | undefined) {
      const drainState = uuid ? httpDrainByUuid.get(uuid) : undefined;
      if (drainState) {
        drainState.resolved = true;
      }
    },
    enqueueHttpDelivery,
  };
}
