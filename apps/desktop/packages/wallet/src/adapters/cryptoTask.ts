import { Worker } from "node:worker_threads";
import { WalletError } from "../domain/errors.js";
let activeWorkers = 0;
export function runCryptoTask<T>(
  moduleUrl: string,
  job: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted)
    return Promise.reject(
      new WalletError("WALLET_OPERATION_ABORTED", "The wallet operation was canceled."),
    );
  if (activeWorkers >= 2)
    return Promise.reject(new WalletError("CRYPTO_BUSY", "Wallet cryptographic workers are busy."));
  activeWorkers++;
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./crypto-worker.mjs", import.meta.url), {
        workerData: { moduleUrl, job },
        env: {},
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 256,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4,
        },
      });
    } catch {
      activeWorkers--;
      reject(new WalletError("CRYPTO_FAILED", "The wallet cryptographic worker could not start."));
      return;
    }
    let settled = false;
    const finish = (error?: WalletError, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate().finally(() => {
        activeWorkers--;
      });
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () =>
      finish(new WalletError("WALLET_OPERATION_ABORTED", "The wallet operation was canceled."));
    const timer = setTimeout(
      () =>
        finish(new WalletError("CRYPTO_TIMEOUT", "The wallet cryptographic operation timed out.")),
      30000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message) =>
      message?.ok === true
        ? finish(undefined, message.result as T)
        : finish(
            new WalletError(
              "BACKUP_INVALID",
              "The password or wallet cryptographic input is invalid.",
            ),
          ),
    );
    worker.once("error", () =>
      finish(new WalletError("CRYPTO_FAILED", "The wallet cryptographic operation failed.")),
    );
    worker.once("exit", () => {
      if (!settled)
        finish(new WalletError("CRYPTO_FAILED", "The wallet cryptographic worker stopped."));
    });
  });
}
