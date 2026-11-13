import timers from "node:timers/promises";

/** One instance per model request. Only positive observations from its own wallet operation refresh idle time. */
type WaitReason = "chain" | "allowance" | "approval" | "queue";
export class WalletAdmissionActivity {
  lastActivityAt = 0;
  publish?: (waiting: boolean, reason?: WaitReason) => Promise<void>;

  async observe(signal: AbortSignal, status: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
    let visible = false;
    try {
      while (!signal.aborted) {
        await timers.setTimeout(visible ? 15_000 : 2_000, undefined, { signal });
        let response: unknown;
        try {
          response = await status(AbortSignal.any([signal, AbortSignal.timeout(5000)]));
        } catch {
          // A failed observation cannot extend either watchdog.
          continue;
        }
        if (signal.aborted) break;
        const waiting = (response as { waiting?: boolean } | null)?.waiting === true;
        if (!waiting && !visible) continue;
        const candidate = (response as { reason?: unknown } | null)?.reason;
        const reason = candidate === "chain" || candidate === "approval" || candidate === "allowance" || candidate === "queue" ? candidate : undefined;
        if (reason !== "chain") this.lastActivityAt = Date.now();
        visible = waiting;
        await this.publish?.(waiting, reason);
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      if (visible) {
        this.lastActivityAt = Date.now();
        await this.publish?.(false);
      }
    }
  }
}
