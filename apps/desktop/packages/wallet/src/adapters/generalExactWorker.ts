import { Worker } from "node:worker_threads";
import { requireWallet, WalletError } from "../domain/errors.js";
import { generalExactPaymentDigest } from "./generalExactPayment.js";
import type { GeneralExactCryptoInput } from "./generalExactCrypto.js";
import { reserveGeneralCryptoWorker } from "./generalCryptoCapacity.js";
export interface GeneralExactWorkerSession { readonly digest: string; commit(expected: string): Promise<string>; close(): Promise<void> }
/** Original protected Host only. Preparation decrypts inside the same bounded
 * worker that will perform at most one fixed-purpose signature. Cancellation
 * retains the original worker/capacity until actual termination returns. */
export async function prepareGeneralExactWorker(input: GeneralExactCryptoInput, signal?: AbortSignal): Promise<GeneralExactWorkerSession> {
  requireWallet(!signal?.aborted, "GENERAL_OPERATION_CANCELED", "The exact-payment preparation was canceled.");
  const digest = generalExactPaymentDigest(input.intent), release = reserveGeneralCryptoWorker(); let worker: Worker;
  try {
    const moduleUrl = new URL(import.meta.url.endsWith(".ts") ? "./generalExactCrypto.ts" : "./exact-crypto.js", import.meta.url).href;
    worker = new Worker(new URL("./general-exact-worker.mjs", import.meta.url), { workerData: { moduleUrl, input }, env: {}, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
  } catch { release(); throw new WalletError("GENERAL_CRYPTO_FAILED", "The exact-payment worker could not start."); }
  finally { input.key.fill(0); }
  let stopped = false, attempted = false, prepared = false, closing: Promise<void> | undefined;
  let preparedResolve!: () => void, preparedReject!: (error: Error) => void, signedResolve: ((signature: string) => void) | undefined, signedReject: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => { preparedResolve = resolve; preparedReject = reject; });
  const unavailable = () => new WalletError("GENERAL_CRYPTO_FAILED", "The original exact-payment worker is unavailable.");
  const stop = (): Promise<void> => {
    if (closing) return closing;
    stopped = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
    preparedReject(unavailable()); signedReject?.(unavailable());
    closing = worker.terminate().then(() => { release(); }, () => { throw unavailable(); }); return closing;
  };
  const abort = () => { void stop().catch(() => {}); };
  const deadline = performance.now() + 30000;
  const timer = setTimeout(abort, 30000); timer.unref();
  signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  worker.on("message", (message: unknown) => {
    if (stopped) return;
    if (!message || typeof message !== "object") { abort(); return; }
    const row = message as Record<string, unknown>;
    if (!prepared && !attempted && Object.keys(row).sort().join() === "digest,kind" && row.kind === "prepared" && row.digest === digest) { prepared = true; preparedResolve(); return; }
    if (prepared && attempted && Object.keys(row).sort().join() === "digest,kind,signature" && row.kind === "signed" && row.digest === digest &&
        typeof row.signature === "string" && /^0x[0-9a-f]{130}$/i.test(row.signature) && !signal?.aborted) { signedResolve?.(row.signature); return; }
    abort();
  });
  worker.on("error", abort); worker.on("exit", () => { if (!stopped) abort(); });
  try { await ready; requireWallet(!stopped && !signal?.aborted, "GENERAL_OPERATION_CANCELED", "The original payment preparation was canceled."); }
  catch (error) { await stop(); throw error; }
  return Object.freeze({ digest,
    commit: async (expected: string) => {
      requireWallet(!stopped && !attempted && !signal?.aborted, "PERMIT_MISMATCH", "The original one-use payment commitment is unavailable."); attempted = true;
      if (expected !== digest) { await stop(); throw new WalletError("PERMIT_MISMATCH", "The original one-use payment digest does not match."); }
      const result = new Promise<string>((resolve, reject) => { signedResolve = resolve; signedReject = reject; });
      try { worker.postMessage({ command: "commit", digest }); const signature = await result; await stop();
        requireWallet(!signal?.aborted && performance.now() < deadline, "GENERAL_OPERATION_CANCELED", "The original exact-payment result expired."); return signature; }
      catch (error) { await stop(); throw error; }
    }, close: stop,
  });
}
