import { performance } from "node:perf_hooks";
import type { GeneralBalanceRpc } from "../app/generalBalances.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { generalRpcEndpoint } from "./generalRpcEndpoints.js";
import { GeneralRpcTransport } from "./generalRpcTransport.js";
import type { GeneralTransferPreview } from "./generalTransferIntent.js";
import type { GeneralEvidenceLifetime } from "./generalSigningCapability.js";

const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
let activeReads = 0;
const issued = new WeakMap<object, { signal: AbortSignal; now: () => number; invalidated: boolean }>();

export type GeneralFeeQuote = Readonly<{
  networkId: string; blockNumber: string; blockHash: string; gasPriceAtomic: string;
  baseFeePerGasAtomic: string | null; priorityFeePerGasAtomic: string | null;
  observedAt: number; expiresAt: number; certainty: "node_observation_not_a_fee_cap";
}>;

function quantity(value: unknown): bigint {
  requireWallet(typeof value === "string" && QUANTITY.test(value), "GENERAL_FEE_UNAVAILABLE", "The node returned an invalid fee quantity.");
  return BigInt(value);
}
function block(input: unknown): { number: string; hash: string; baseFee: string | null } {
  requireWallet(input && typeof input === "object" && !Array.isArray(input), "GENERAL_FEE_UNAVAILABLE", "The node returned an invalid block.");
  const row = input as Record<string, unknown>;
  requireWallet(typeof row.number === "string" && QUANTITY.test(row.number) && typeof row.hash === "string" && HASH.test(row.hash),
    "GENERAL_FEE_UNAVAILABLE", "The node returned an invalid block identity.");
  const baseFee = row.baseFeePerGas === undefined || row.baseFeePerGas === null ? null : quantity(row.baseFeePerGas).toString();
  return { number: row.number.toLowerCase(), hash: row.hash.toLowerCase(), baseFee };
}

/** Read-only node observations; the owner must keep this reader alive while using a quote. */
export class GeneralFeeQuoteReader {
  private readonly shutdown = new AbortController();
  private active = false;
  constructor(private readonly networkId: string,
    private readonly rpc: GeneralBalanceRpc = new GeneralRpcTransport(generalRpcEndpoint(networkId), undefined, "fee"),
    private readonly now: () => number = () => Math.floor(performance.now())) {}

  async read(parent?: AbortSignal): Promise<GeneralFeeQuote> {
    const network = generalNetwork(this.networkId), started = this.now();
    requireWallet(Number.isSafeInteger(started) && started >= 0 && started <= Number.MAX_SAFE_INTEGER - 20000 &&
      !this.active && activeReads < 2 && !this.shutdown.signal.aborted && !parent?.aborted,
    "GENERAL_FEE_UNAVAILABLE", "The network fee observation is unavailable.");
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(20000), ...(parent ? [parent] : [])]);
    const pending = new Set<Promise<unknown>>();
    const call = async (method: string, params: readonly unknown[]): Promise<unknown> => {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
      if (bounded.aborted) throw new WalletError("GENERAL_FEE_UNAVAILABLE", "The network fee observation is unavailable.");
      let onAbort = () => {};
      const stopped = new Promise<never>((_, reject) => {
        onAbort = () => reject(new WalletError("GENERAL_FEE_UNAVAILABLE", "The network fee observation is unavailable."));
        bounded.addEventListener("abort", onAbort, { once: true }); if (bounded.aborted) onAbort();
      });
      const work = Promise.resolve().then(() => { if (bounded.aborted) throw new Error("Canceled"); return this.rpc.call(method, params, bounded); });
      pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work));
      try { return await Promise.race([work, stopped]); } finally { bounded.removeEventListener("abort", onAbort); }
    };
    this.active = true; activeReads++;
    try {
      requireWallet(quantity(await call("eth_chainId", [])) === BigInt(network.chainId), "GENERAL_FEE_UNAVAILABLE", "The fee RPC network is invalid.");
      const initial = block(await call("eth_getBlockByNumber", ["latest", false]));
      const [rawPrice, rawPriority] = await Promise.all([
        call("eth_gasPrice", []), call("eth_maxPriorityFeePerGas", []).catch(() => null),
      ]);
      const gasPrice = quantity(rawPrice), priority = rawPriority === null ? null : quantity(rawPriority).toString();
      requireWallet(gasPrice > 0n, "GENERAL_FEE_UNAVAILABLE", "The node returned an invalid gas price.");
      const final = block(await call("eth_getBlockByNumber", [initial.number, false]));
      const chain = await call("eth_chainId", []), current = this.now();
      requireWallet(final.number === initial.number && final.hash === initial.hash && final.baseFee === initial.baseFee &&
        quantity(chain) === BigInt(network.chainId) && Number.isSafeInteger(current) && current >= started && current - started < 20000 && !signal.aborted,
      "GENERAL_FEE_UNAVAILABLE", "The network fee observation is stale.");
      const quote: GeneralFeeQuote = Object.freeze({ networkId: network.id, blockNumber: BigInt(initial.number).toString(), blockHash: initial.hash,
        gasPriceAtomic: gasPrice.toString(), baseFeePerGasAtomic: initial.baseFee, priorityFeePerGasAtomic: priority,
        observedAt: started, expiresAt: started + 20000, certainty: "node_observation_not_a_fee_cap" });
      issued.set(quote, { signal, now: () => this.now(), invalidated: false });
      return quote;
    } catch { throw new WalletError("GENERAL_FEE_UNAVAILABLE", "The network fee observation is unavailable."); }
    finally {
      const release = () => { this.active = false; activeReads--; };
      if (pending.size) void Promise.allSettled(pending).then(release); else release();
    }
  }

  close(): void { this.shutdown.abort(); }
}

/** Only the original live observation can accompany a particular frozen transfer. */
export function bindGeneralFeeQuote(quote: GeneralFeeQuote, preview: GeneralTransferPreview, now: number): GeneralEvidenceLifetime {
  const source = quote && typeof quote === "object" ? issued.get(quote) : undefined;
  const isLive = () => {
    try {
      const current = source?.now();
      if (!source) return false;
      if (source.signal.aborted || !Number.isSafeInteger(current) || current! < quote.observedAt || current! >= quote.expiresAt) source.invalidated = true;
      return !source.invalidated;
    } catch { if (source) source.invalidated = true; return false; }
  };
  if (source && (!Number.isSafeInteger(now) || now < quote.observedAt || now >= quote.expiresAt)) source.invalidated = true;
  requireWallet(source && quote.networkId === preview.networkId && Number.isSafeInteger(now) && now >= quote.observedAt &&
    now < quote.expiresAt && isLive(), "GENERAL_FEE_UNAVAILABLE", "The fee observation is unavailable or expired.");
  const price = preview.fee.type === "legacy" ? BigInt(preview.fee.gasPriceAtomic) : BigInt(preview.fee.maxFeePerGasAtomic);
  requireWallet(preview.fee.type === "legacy" || quote.baseFeePerGasAtomic !== null,
    "GENERAL_FEE_UNAVAILABLE", "The base fee observation is unavailable.");
  requireWallet(quote.baseFeePerGasAtomic === null || price >= BigInt(quote.baseFeePerGasAtomic),
    "GENERAL_FEE_CHANGED", "The frozen fee cannot cover the observed base fee.");
  return { startedAt: quote.observedAt, expiresAt: quote.expiresAt, isLive };
}
