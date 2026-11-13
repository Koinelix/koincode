import { WalletError, requireWallet } from "../domain/errors.js";

export class RpcRateLimit extends WalletError {
  readonly retryAfterMs: number;
  constructor(header: string | null) {
    super("RPC_RATE_LIMITED", "The wallet RPC rate limit was reached.");
    const value = header?.trim();
    const parsed = !value ? 0 : /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
    this.retryAfterMs = Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
  }
}

const TRANSIENT = new Set(["RPC_UNAVAILABLE", "RPC_TIMEOUT", "RPC_RATE_LIMITED", "RPC_HTTP_UNAVAILABLE", "RPC_NODE_UNAVAILABLE"]);
export function retryableRpcFailure(error: unknown): boolean {
  return error instanceof WalletError && TRANSIENT.has(error.code);
}
export type RpcReadRequest = { jsonrpc: "2.0"; id: number; method: string; params: unknown[] };

/** Read-only transport details stay inside the RPC adapter. Never returns provider error bodies. */
async function postRpcJson(fetchImpl: typeof fetch, endpoint: string, body: unknown,
  timeoutMs: number, parent: AbortSignal | undefined, batch: boolean): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([timeout, ...(parent ? [parent] : [])]);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 429) throw new RpcRateLimit(response.headers.get("retry-after"));
      const code = [502, 503, 504].includes(response.status) ? "RPC_HTTP_UNAVAILABLE"
          : batch && [400, 405, 413].includes(response.status) ? "RPC_BATCH_UNSUPPORTED" : "RPC_REJECTED";
      throw new WalletError(code, "The wallet RPC returned an unsuccessful HTTP status.");
    }
    const reader = response.body?.getReader();
    requireWallet(reader, "RPC_RESPONSE_INVALID", "The wallet RPC response is missing.");
    let size = 0;
    const chunks: Buffer[] = [];
    try {
      for (;;) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        requireWallet(size <= 2 * 1024 * 1024, "RPC_RESPONSE_TOO_LARGE", "The wallet RPC response exceeds its limit.");
        chunks.push(Buffer.from(part.value));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new WalletError("RPC_RESPONSE_INVALID", "The wallet RPC response is not valid JSON."); }
  } catch (error) {
    if (parent?.aborted) throw new WalletError("WALLET_OPERATION_ABORTED", "The RPC request was canceled.");
    if (timeout.aborted) throw new WalletError("RPC_TIMEOUT", "The wallet RPC read timed out.");
    if (error instanceof WalletError) throw error;
    throw new WalletError("RPC_UNAVAILABLE", "The wallet RPC connection or response read failed.");
  }
}

/** JSON-RPC provider codes for request-rate limits (-32005 standard, -32007 Base public endpoints). */
const RATE_LIMIT_CODES = new Set([-32005, -32007]);
const rateLimited = (item: unknown) =>
  RATE_LIMIT_CODES.has(((item as { error?: { code?: unknown } } | null)?.error?.code) as number);
/**
 * Load-balanced public endpoints answer from backends at different heights: -32001 means the pinned block
 * has not reached this backend yet and -32004 means the backend could not serve the read. Both are retryable;
 * generic codes such as -32000 also carry real call failures and stay rejected. EIP-1474 assigns -32004 to
 * "method not supported"; the wallet only calls fixed Base endpoints that use it for an unserved read, and a
 * standard endpoint would cost at most the bounded lagging-node retries before reporting this code.
 */
const NODE_UNAVAILABLE_CODES = new Set([-32001, -32004]);
const nodeUnavailable = (item: unknown) =>
  NODE_UNAVAILABLE_CODES.has(((item as { error?: { code?: unknown } } | null)?.error?.code) as number);
const itemError = (item: unknown) => (item as { error?: unknown } | null)?.error !== undefined;

function rpcResult(decoded: unknown, id: number, allowNodeRetry = true): unknown {
  const item = decoded as { jsonrpc?: string; id?: number; result?: unknown; error?: unknown } | null;
  requireWallet(item && typeof item === "object" && item.jsonrpc === "2.0" && item.id === id,
    "RPC_RESPONSE_INVALID", "The wallet RPC response identity does not match.");
  if (rateLimited(item)) throw new WalletError("RPC_RATE_LIMITED", "The wallet RPC rate limit was reached.");
  if (allowNodeRetry && nodeUnavailable(item))
    throw new WalletError("RPC_NODE_UNAVAILABLE", "The wallet RPC node has not reached the requested block.");
  requireWallet(!item.error, "RPC_REJECTED", "The wallet RPC rejected the read request.");
  requireWallet(item.result !== undefined, "RPC_RESPONSE_INVALID", "The wallet RPC result is missing.");
  return item.result;
}

export async function readRpcAttempt(fetchImpl: typeof fetch, endpoint: string,
  request: RpcReadRequest, timeoutMs: number, parent?: AbortSignal): Promise<unknown> {
  return rpcResult(await postRpcJson(fetchImpl, endpoint, request, timeoutMs, parent, false), request.id);
}

/** One HTTP batch; every requested ID must be answered exactly once, and any item error rejects the batch. */
export async function readRpcBatchAttempt(fetchImpl: typeof fetch, endpoint: string,
  requests: readonly RpcReadRequest[], timeoutMs: number, parent?: AbortSignal): Promise<unknown[]> {
  requireWallet(requests.length > 0 && new Set(requests.map(item => item.id)).size === requests.length,
    "RPC_BUDGET_EXHAUSTED", "The RPC batch is empty or has duplicate identities.");
  const decoded = await postRpcJson(fetchImpl, endpoint, requests, timeoutMs, parent, true);
  if (!Array.isArray(decoded)) {
    if (rateLimited(decoded)) throw new WalletError("RPC_RATE_LIMITED", "The wallet RPC rate limit was reached.");
    throw new WalletError("RPC_BATCH_UNSUPPORTED", "The wallet RPC does not accept batch reads.");
  }
  requireWallet(decoded.length === requests.length, "RPC_RESPONSE_INVALID", "The wallet RPC batch response size does not match.");
  const byId = new Map<number, unknown>();
  for (const item of decoded) {
    const id = (item as { id?: unknown } | null)?.id;
    requireWallet(typeof id === "number" && !byId.has(id), "RPC_RESPONSE_INVALID", "The wallet RPC batch identity is invalid.");
    byId.set(id, item);
  }
  // A partially rate-limited batch is retried as a whole; other item errors still reject it.
  if (decoded.some(rateLimited) && requests.every(request => byId.has(request.id)))
    throw new WalletError("RPC_RATE_LIMITED", "The wallet RPC rate limit was reached.");
  // A lagging backend is retried as a whole batch only when the batch is complete and no item carries a real error.
  const retryable = requests.every(request => byId.has(request.id)) &&
    !decoded.some(item => itemError(item) && !rateLimited(item) && !nodeUnavailable(item));
  return requests.map(request => {
    requireWallet(byId.has(request.id), "RPC_RESPONSE_INVALID", "The wallet RPC batch response is incomplete.");
    return rpcResult(byId.get(request.id), request.id, retryable);
  });
}
