import { WalletError, requireWallet } from "../domain/errors.js";
import type { RequestWork } from "./requestPorts.js";

export function clientRequestWork(
  signal?: AbortSignal,
  assertContext?: () => void,
): RequestWork | undefined {
  return signal || assertContext
    ? {
        signal: signal ?? AbortSignal.any([]),
        callerSignal: signal,
        assertCurrent: () => {
          requireWallet(
            !signal?.aborted,
            "WALLET_OPERATION_ABORTED",
            "The client canceled the operation.",
          );
          assertContext?.();
        },
      }
    : undefined;
}

export async function withClientCancellation(
  signal: AbortSignal | undefined,
  cancel: () => Promise<unknown>,
  execute: () => Promise<void>,
): Promise<void> {
  const stop = () => {
    void cancel().catch(() => {});
  };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    if (signal?.aborted) {
      await cancel();
      return;
    }
    await execute();
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}
export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(
        new WalletError(
          "WALLET_OPERATION_ABORTED",
          "The request was canceled or exceeded its deadline.",
        ),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
