import { setTimeout as delay } from "node:timers/promises";
import { REMOTE_HOST_LIMITS, RemoteHostError } from "@fcode/shared";

export type WindowsIoState = { done: false } | { done: true; bytes: number; error?: Error };
export interface WindowsPendingIo {
  poll(): WindowsIoState;
  cancel(): void;
  dispose(): void;
}

/** Pending kernel I/O owns its stable memory until completion, including after cancellation. */
export async function waitForWindowsIo(operation: WindowsPendingIo, signal: AbortSignal,
  options: { cancelWaitMs?: number; pollMs?: number; fatal?: () => never } = {}): Promise<number> {
  let completed = false;
  let terminating = false;
  const fatal = (): never => { terminating = true; return (options.fatal ?? (() => process.exit(1)))(); };
  let canceledAt: number | undefined;
  const cancel = () => {
    if (canceledAt !== undefined) return;
    canceledAt = performance.now();
    try { operation.cancel(); } catch { /* Keep polling until completion or terminate the broker. */ }
  };
  const cancelWaitMs = Math.min(options.cancelWaitMs ?? REMOTE_HOST_LIMITS.cancelWaitMs, REMOTE_HOST_LIMITS.cancelWaitMs);
  const pollMs = Math.min(options.pollMs ?? 20, 100);
  if (!(cancelWaitMs > 0 && pollMs > 0)) throw new Error("Invalid Windows I/O wait budget");
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    for (;;) {
      const state = operation.poll();
      if (state.done) {
        completed = true;
        if (signal.aborted) throw signal.reason ?? new RemoteHostError("canceled", "The private pipe request was canceled.");
        if (state.error) throw state.error;
        if (!Number.isSafeInteger(state.bytes) || state.bytes < 0) throw new RemoteHostError("connection_failed", "The private pipe returned an invalid byte count.", "connection");
        return state.bytes;
      }
      if (canceledAt !== undefined && performance.now() - canceledAt >= cancelWaitMs) {
        // Exiting the utility lets the OS reclaim pending buffers without a use-after-free.
        fatal();
      }
      await delay(pollMs);
    }
  } catch (error) {
    if (!completed && !terminating) fatal();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (completed) operation.dispose();
  }
}
