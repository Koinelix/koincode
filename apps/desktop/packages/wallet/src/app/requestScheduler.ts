import { abortable } from "./requestWait.js";
import type { RequestWork } from "./requestPorts.js";
import type { ClientHandle } from "./sessions.js";
import type { RequestStore } from "./requestStore.js";
import { WalletError } from "../domain/errors.js";
export class RequestScheduler {
  #jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  #closed = false;
  constructor(
    private readonly store: RequestStore,
    private readonly progress: (
      handle: ClientHandle,
      id: string,
      work: RequestWork,
    ) => Promise<unknown>,
  ) {}
  async schedule(handle: ClientHandle, id: string, callerSignal?: AbortSignal): Promise<void> {
    if (this.#closed || this.#jobs.has(id) || this.#jobs.size >= 8) return;
    const record = this.store.owned(handle, id);
    if (
      record.canceled ||
      record.replacementCount !== 0 ||
      record.action !== "request" ||
      record.httpStatus !== 402 ||
      record.signedChallengeValid !== true
    )
      return;
    const frozen = await this.store.frozen(record),
      policy = this.store.replayPolicy(frozen);
    if (this.#closed) return;
    if (
      record.canceled ||
      record.replacementCount !== 0 ||
      record.action !== "request" ||
      record.httpStatus !== 402 ||
      record.signedChallengeValid !== true ||
      !policy?.safeReplay ||
      policy.expiresAt <= this.store.env.wall()
    )
      return;
    const controller = new AbortController(),
      signal = AbortSignal.any([
        controller.signal,
        this.store.ctx.fence.signal,
        AbortSignal.timeout(600000),
        ...(callerSignal ? [callerSignal] : []),
      ]),
      until = this.store.env.wall() + 600000,
      startedMono = this.store.env.monotonic();
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const work: RequestWork = {
      signal,
      callerSignal,
      assertCurrent: () => {
        if (
          signal.aborted ||
          this.#closed ||
          this.store.env.wall() >= until ||
          this.store.env.monotonic() - startedMono >= 600000
        )
          throw new WalletError(
            "WALLET_OPERATION_ABORTED",
            "The automatic request work deadline expired or was canceled.",
          );
      },
    };
    this.#jobs.set(id, { controller, done });
    try {
      await this.store.update(id, (r) => {
        r.reconciliationPending = true;
        r.autoUntil = until;
        r.autoAttempts = 0;
      });
    } catch (error) {
      this.#jobs.delete(id);
      complete();
      throw error;
    }
    void (async () => {
      try {
        for (
          let attempt = 0;
          attempt < 24 &&
          !signal.aborted &&
          this.store.env.wall() < until &&
          this.store.env.monotonic() - startedMono < 600000;
          attempt++
        ) {
          await this.store.env.delay(
            Math.min(
              30000,
              1000 * 2 ** attempt,
              until - this.store.env.wall(),
              600000 - (this.store.env.monotonic() - startedMono),
            ),
            signal,
          );
          work.assertCurrent();
          const current = this.store.owned(handle, id),
            original = await this.store.frozen(current);
          this.store.assertCurrent(handle, current, original);
          if (
            current.canceled ||
            current.replacementCount !== 0 ||
            current.signedChallengeValid !== true
          )
            break;
          const live = this.store.replayPolicy(original);
          if (!live?.safeReplay || live.expiresAt <= this.store.env.wall()) break;
          await this.store.update(id, (r) => {
            r.autoAttempts = attempt + 1;
          });
          try {
            await abortable(this.progress(handle, id, work), signal);
          } catch (error) {
            if (
              !(error instanceof WalletError) ||
              !["RPC_UNAVAILABLE", "RPC_BUSY", "RPC_BUDGET_EXHAUSTED"].includes(error.code)
            )
              break;
          }
          const after = this.store.owned(handle, id),
            intent = this.store.ctx.state
              .snapshot()
              .intents.findLast((x) => x.requestId === id && x.clientId === after.clientId);
          if (
            after.canceled ||
            after.replacementCount !== 0 ||
            after.diagnosticCode === "QUOTE_REFRESH_BUSINESS_RESULT" ||
            intent?.spent ||
            intent?.status === "CANCELED_UNSETTLED"
          )
            break;
        }
      } catch {
        /* Work stops without granting a retry or clearing money risk. */
      } finally {
        try {
          await this.store.update(id, (r) => {
            r.reconciliationPending = false;
          });
        } catch {
          /* Preserve the last protected state on shutdown/storage failure. */
        }
        this.#jobs.delete(id);
        complete();
      }
    })();
  }
  cancel(id: string): void {
    this.#jobs.get(id)?.controller.abort();
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.#jobs.values()].map((job) => job.done));
  }
}
