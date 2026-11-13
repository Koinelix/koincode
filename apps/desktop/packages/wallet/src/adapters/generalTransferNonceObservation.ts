import type { GeneralBalanceRpc } from "../app/generalBalances.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { generalRpcEndpoint } from "./generalRpcEndpoints.js";
import { GeneralRpcTransport } from "./generalRpcTransport.js";
import { assertGeneralTransferPreview, type GeneralTransferPreview } from "./generalTransferIntent.js";

const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
let activeReads = 0;

export type GeneralNonceObservation = Readonly<{
  status: "NONCE_CONSUMED_EFFECT_UNKNOWN" | "NONCE_NOT_PROVEN_CONSUMED";
  accountAddress: string; networkId: string; transactionNonce: number; observedNonce: string;
  blockNumber: string; blockHash: string; source: "rpc_reported_finalized"; finality: "policy_not_evaluated";
}>;

function number(value: unknown): bigint {
  requireWallet(typeof value === "string" && QUANTITY.test(value), "GENERAL_EVIDENCE_UNAVAILABLE", "The nonce observation is invalid.");
  return BigInt(value);
}
function block(value: unknown): { number: bigint; hash: string } {
  requireWallet(value && typeof value === "object" && !Array.isArray(value), "GENERAL_EVIDENCE_UNAVAILABLE", "The reported block is unavailable.");
  const row = value as Record<string, unknown>;
  requireWallet(typeof row.hash === "string" && HASH.test(row.hash), "GENERAL_EVIDENCE_UNAVAILABLE", "The reported block is invalid.");
  return { number: number(row.number), hash: row.hash.toLowerCase() };
}

/** A node's finalized tag is an observation, not a verified network finality policy or authority to release risk. */
export class GeneralTransferNonceObservationReader {
  private readonly shutdown = new AbortController();
  private active = false;
  constructor(private readonly networkId: string,
    private readonly rpc: GeneralBalanceRpc = new GeneralRpcTransport(generalRpcEndpoint(networkId), undefined, "nonce_history")) {}

  async read(preview: GeneralTransferPreview, signal: AbortSignal): Promise<GeneralNonceObservation> {
    const network = generalNetwork(this.networkId), frozen = structuredClone(preview);
    requireWallet(frozen && frozen.networkId === network.id && Number.isSafeInteger(frozen.expiresAt) && frozen.expiresAt > 0,
      "GENERAL_EVIDENCE_UNAVAILABLE", "The transaction identity is unavailable.");
    // Structural recovery validation does not renew the expired approval or authorize a signature.
    assertGeneralTransferPreview(frozen, frozen.digest, frozen.expiresAt - 1);
    requireWallet(!signal.aborted && !this.shutdown.signal.aborted && !this.active && activeReads < 2,
      "GENERAL_EVIDENCE_UNAVAILABLE", "The nonce observation is unavailable.");
    const combined = AbortSignal.any([signal, this.shutdown.signal, AbortSignal.timeout(20000)]), pending = new Set<Promise<unknown>>();
    const call = async (method: string, params: readonly unknown[]): Promise<unknown> => {
      const bounded = AbortSignal.any([combined, AbortSignal.timeout(8000)]);
      if (bounded.aborted) throw new WalletError("GENERAL_EVIDENCE_UNAVAILABLE", "The nonce observation was canceled.");
      let onAbort = () => {};
      const stopped = new Promise<never>((_, reject) => {
        onAbort = () => reject(new WalletError("GENERAL_EVIDENCE_UNAVAILABLE", "The nonce observation was canceled."));
        bounded.addEventListener("abort", onAbort, { once: true }); if (bounded.aborted) onAbort();
      });
      const work = Promise.resolve().then(() => { if (bounded.aborted) throw new Error("Canceled"); return this.rpc.call(method, params, bounded); });
      pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work));
      try { return await Promise.race([work, stopped]); } finally { bounded.removeEventListener("abort", onAbort); }
    };
    this.active = true; activeReads++;
    try {
      requireWallet(number(await call("eth_chainId", [])) === BigInt(network.chainId), "GENERAL_EVIDENCE_UNAVAILABLE", "The nonce RPC network is invalid.");
      const initial = block(await call("eth_getBlockByNumber", ["finalized", false]));
      const tag = `0x${initial.number.toString(16)}`;
      const before = block(await call("eth_getBlockByNumber", [tag, false]));
      requireWallet(before.number === initial.number && before.hash === initial.hash, "GENERAL_EVIDENCE_UNAVAILABLE", "The reported block changed.");
      const nonce = number(await call("eth_getTransactionCount", [frozen.accountAddress, tag]));
      const after = block(await call("eth_getBlockByNumber", [tag, false]));
      const latest = block(await call("eth_getBlockByNumber", ["finalized", false]));
      const chain = number(await call("eth_chainId", []));
      requireWallet(!combined.aborted && chain === BigInt(network.chainId) && after.number === initial.number && after.hash === initial.hash &&
        latest.number >= initial.number && (latest.number !== initial.number || latest.hash === initial.hash),
      "GENERAL_EVIDENCE_UNAVAILABLE", "The reported block changed during observation.");
      return Object.freeze({ status: nonce > BigInt(frozen.nonce) ? "NONCE_CONSUMED_EFFECT_UNKNOWN" : "NONCE_NOT_PROVEN_CONSUMED",
        accountAddress: frozen.accountAddress, networkId: network.id, transactionNonce: frozen.nonce, observedNonce: nonce.toString(),
        blockNumber: initial.number.toString(), blockHash: initial.hash, source: "rpc_reported_finalized", finality: "policy_not_evaluated" });
    } catch { throw new WalletError("GENERAL_EVIDENCE_UNAVAILABLE", "The nonce observation is unavailable."); }
    finally {
      const release = () => { this.active = false; activeReads--; };
      if (pending.size) void Promise.allSettled(pending).then(release); else release();
    }
  }

  close(): void { this.shutdown.abort(); }
}
