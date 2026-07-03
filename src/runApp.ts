import { resolveLucentConfig } from "./config";

/**
 * Host entry: boots the R.wasm worker, registers the transport service worker,
 * and brokers the Comlink connection between them.
 *
 * Ported from site/runApp.js in the move-runtime step.
 */
export async function runApp(): Promise<void> {
  const config = resolveLucentConfig();
  console.info("[lucent] host entry (scaffold)", config);

  const worker = new Worker(new URL("./rWasmWorker.js", import.meta.url), {
    type: "module",
  });
  worker.addEventListener("message", (event) => {
    console.info("[lucent] worker message (scaffold)", event.data);
  });
}

void runApp();
