/// <reference lib="webworker" />

// Worker entry: loads R.wasm, installs the httpuv bridge, and drives the
// service loop / Comlink host API.
//
// Ported from site/rWasmWorker.js in the move-runtime step.
const workerSelf = self as unknown as DedicatedWorkerGlobalScope;

workerSelf.postMessage({ type: "lucent-scaffold-ready" });

export {};
