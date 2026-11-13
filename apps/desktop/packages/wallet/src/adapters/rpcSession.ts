import { RpcRateLimit, readRpcAttempt, readRpcBatchAttempt, retryableRpcFailure } from "./rpcReadTransport.js";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { requireWallet, WalletError } from "../domain/errors.js";
const READ_METHODS = new Set([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_call",
  "eth_getLogs",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
]);
export type RpcRead = { method: string; params: unknown[] };
// Public Base endpoints count batch items against 25 requests per second.
const BATCH_LIMIT = 16;
/** A lagging load-balanced backend usually catches up within one or two 2 s blocks. */
const NODE_RETRY_DELAYS_MS = [500, 1000, 2000] as const;
/** Waits before the next attempt, or returns false when the failure must be reported. */
function retryDelay(error: unknown, attempt: number): number | false {
  if (!retryableRpcFailure(error)) return false;
  const code = (error as WalletError).code;
  if (code === "RPC_NODE_UNAVAILABLE") return NODE_RETRY_DELAYS_MS[attempt] ?? false;
  if (code === "RPC_RATE_LIMITED") {
    const minimum = error instanceof RpcRateLimit ? error.retryAfterMs : 0;
    if (attempt >= 3 || minimum > 8000) return false;
    return Math.max(minimum, 1000 * 2 ** attempt + Math.floor(Math.random() * 250));
  }
  return attempt === 0 ? 250 : false;
}
export class RpcSession {
  #calls = 0;
  #ids = 0;
  #started = performance.now();
  #batchUnsupported = false;
  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: typeof fetch,
    private readonly pace: (signal?: AbortSignal, cost?: number) => Promise<void>,
    private readonly signal?: AbortSignal,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<unknown> =
      (ms, signal) => delay(ms, undefined, { signal }),
  ) {}
  /**
   * Reads in bounded JSON-RPC batches; each item counts toward the same work budget and pacing as a single call.
   * Chunks reserve the shared pacing queue one at a time and are sent without waiting for earlier responses.
   */
  async batch(reads: readonly RpcRead[]): Promise<unknown[]> {
    if (!reads.length) return [];
    requireWallet(
      reads.every(read => READ_METHODS.has(read.method)) && this.#calls + reads.length <= 3000 &&
        performance.now() - this.#started < 900000,
      "RPC_BUDGET_EXHAUSTED",
      "The read-only RPC work budget is exhausted.",
    );
    const running: Array<Promise<unknown[]>> = [];
    let failed = false;
    try {
      for (let offset = 0; offset < reads.length && !failed; offset += BATCH_LIMIT) {
        const chunk = reads.slice(offset, offset + BATCH_LIMIT);
        const batched = !this.#batchUnsupported && chunk.length > 1;
        if (batched) await this.pace(this.signal, chunk.length);
        const result = batched ? this.batchChunk(chunk, true) : this.sequential(chunk);
        result.catch(() => { failed = true; });
        running.push(result);
      }
    } catch (error) {
      await Promise.allSettled(running);
      throw error;
    }
    const settled = await Promise.allSettled(running);
    for (const item of settled) if (item.status === "rejected") throw item.reason;
    return settled.flatMap(item => (item as PromiseFulfilledResult<unknown[]>).value);
  }
  /** The original single-read path, one paced read after another. */
  private async sequential(chunk: readonly RpcRead[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const read of chunk) results.push(await this.call(read.method, read.params));
    return results;
  }
  private async batchChunk(chunk: readonly RpcRead[], paced: boolean): Promise<unknown[]> {
    for (let attempt = 0; ; attempt++) {
      const requests = chunk.map(read => ({ jsonrpc: "2.0" as const, id: ++this.#ids, method: read.method, params: read.params }));
      this.#calls += chunk.length;
      if (attempt > 0 || !paced) await this.pace(this.signal, chunk.length);
      requireWallet(!this.signal?.aborted, "WALLET_OPERATION_ABORTED", "The RPC request was canceled.");
      const remaining = Math.ceil(900000 - (performance.now() - this.#started));
      requireWallet(remaining > 0 && this.#calls <= 3000, "RPC_BUDGET_EXHAUSTED", "The RPC work budget is exhausted.");
      try {
        return await readRpcBatchAttempt(this.fetchImpl, this.endpoint, requests, Math.min(8000, remaining), this.signal);
      } catch (error) {
        if (this.signal?.aborted) throw new WalletError("WALLET_OPERATION_ABORTED", "The RPC request was canceled.");
        if (error instanceof WalletError && error.code === "RPC_BATCH_UNSUPPORTED") {
          this.#batchUnsupported = true;
          this.#calls -= chunk.length; // The unanswered batch is replaced by counted single reads.
          return this.sequential(chunk);
        }
        const wait = retryDelay(error, attempt);
        if (wait === false) throw error;
        await this.backoff(wait);
      }
    }
  }
  /** Cancellation during a retry wait is reported as the operation's cancellation, not a transport failure. */
  private async backoff(ms: number): Promise<void> {
    try { await this.sleep(ms, this.signal); }
    catch (error) {
      if (this.signal?.aborted) throw new WalletError("WALLET_OPERATION_ABORTED", "The RPC request was canceled.");
      throw error;
    }
    requireWallet(!this.signal?.aborted, "WALLET_OPERATION_ABORTED", "The RPC request was canceled.");
  }
  async call(method: string, params: unknown[]): Promise<unknown> {
    requireWallet(
      READ_METHODS.has(method) && this.#calls < 3000 && performance.now() - this.#started < 900000,
      "RPC_BUDGET_EXHAUSTED",
      "The read-only RPC work budget is exhausted.",
    );
    for (let attempt = 0; ; attempt++) {
      const id = ++this.#ids;
      this.#calls++;
      await this.pace(this.signal);
      requireWallet(!this.signal?.aborted, "WALLET_OPERATION_ABORTED", "The RPC request was canceled.");
      const remaining = Math.ceil(900000 - (performance.now() - this.#started));
      requireWallet(remaining > 0 && this.#calls <= 3000, "RPC_BUDGET_EXHAUSTED", "The RPC work budget is exhausted.");
      try {
        return await readRpcAttempt(this.fetchImpl, this.endpoint, { jsonrpc: "2.0", id, method, params },
          Math.min(8000, remaining), this.signal);
      } catch (error) {
        if (this.signal?.aborted) throw new WalletError("WALLET_OPERATION_ABORTED", "The RPC request was canceled.");
        const wait = retryDelay(error, attempt);
        if (wait === false) throw error;
        await this.backoff(wait);
      }
    }
  }
}
