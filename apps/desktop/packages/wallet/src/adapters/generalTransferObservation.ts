import type { GeneralBalanceRpc } from "../app/generalBalances.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { generalRpcEndpoint } from "./generalRpcEndpoints.js";
import { GeneralRpcTransport } from "./generalRpcTransport.js";
import { evaluateGeneralTransferEvidence, type GeneralReceiptObservation, type GeneralTransferEvidence } from "./generalTransferEvidence.js";
import type { GeneralTransferPreview } from "./generalTransferIntent.js";

const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
let activeReaders = 0;
type ObservationInput = { preview: GeneralTransferPreview; approvedDigest: string; transactionHash: string;
  requiredConfirmations: number; signal?: AbortSignal };
export type GeneralNodeFinalizedObservation = {
  evidence: GeneralTransferEvidence;
  nodeFinalized: { blockNumber: string; blockHash: string; relation: "receipt_at_or_before_tag" | "receipt_after_tag" } | null;
  finality: "policy_not_evaluated";
};
function fail(): never { throw new WalletError("GENERAL_EVIDENCE_UNAVAILABLE", "The transaction observation is unavailable."); }
function quantity(value: unknown): string {
  if (typeof value !== "string" || !QUANTITY.test(value)) return fail();
  return BigInt(value).toString();
}
function block(value: unknown): { number: string; hash: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const item = value as Record<string, unknown>;
  if (typeof item.hash !== "string" || !HASH.test(item.hash)) return fail();
  return { number: quantity(item.number), hash: item.hash.toLowerCase() };
}
function receipt(value: unknown, chainId: number): GeneralReceiptObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (typeof row.transactionHash !== "string" || !HASH.test(row.transactionHash) || typeof row.blockHash !== "string" || !HASH.test(row.blockHash) ||
      typeof row.from !== "string" || !ADDRESS.test(row.from) || typeof row.to !== "string" || !ADDRESS.test(row.to) ||
      (row.status !== "0x0" && row.status !== "0x1") || !Array.isArray(row.logs) || row.logs.length > 4096) return fail();
  const logs = row.logs.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    const log = value as Record<string, unknown>;
    if (typeof log.address !== "string" || !ADDRESS.test(log.address) || !Array.isArray(log.topics) || log.topics.length > 4 ||
        log.topics.some((topic: unknown) => typeof topic !== "string" || !HASH.test(topic)) || typeof log.data !== "string" ||
        !/^0x(?:[0-9a-fA-F]{2}){0,4096}$/.test(log.data) || typeof log.removed !== "boolean") return fail();
    return { address: log.address.toLowerCase(), topics: (log.topics as string[]).map((topic) => topic.toLowerCase()),
      data: log.data.toLowerCase(), removed: log.removed };
  });
  return { chainId, transactionHash: row.transactionHash.toLowerCase(), from: row.from.toLowerCase(), to: row.to.toLowerCase(),
    status: row.status === "0x1" ? 1 : 0, blockNumber: quantity(row.blockNumber), blockHash: row.blockHash.toLowerCase(),
    gasUsed: quantity(row.gasUsed), effectiveGasPrice: quantity(row.effectiveGasPrice), logs };
}

/** Bounded read-only observation; never signs, broadcasts, retries a payment, or releases a risk. */
export class GeneralTransferObservationReader {
  private readonly shutdown = new AbortController();
  private active = false;
  constructor(private readonly networkId: string,
    private readonly rpc: GeneralBalanceRpc = new GeneralRpcTransport(generalRpcEndpoint(networkId), undefined, "receipt")) {}

  async read(input: ObservationInput): Promise<GeneralTransferEvidence> {
    return (await this.observe(input, false)).evidence;
  }

  /** A node's tag is a reported observation, not chain finality or permission to release a risk. */
  async readNodeFinalized(input: ObservationInput): Promise<GeneralNodeFinalizedObservation> {
    const result = await this.observe({ ...input, requiredConfirmations: 100000 }, true);
    return { ...result, evidence: result.evidence.status === "CONFIRMED" ? { ...result.evidence, status: "MINED" } : result.evidence,
      finality: "policy_not_evaluated" };
  }

  private async observe(input: ObservationInput, includeFinalized: boolean): Promise<Omit<GeneralNodeFinalizedObservation, "finality">> {
    const network = generalNetwork(this.networkId);
    requireWallet(input.preview.networkId === network.id, "GENERAL_EVIDENCE_INVALID", "The transaction network is invalid.");
    const frozen = structuredClone(input.preview);
    const base = { preview: frozen, approvedDigest: input.approvedDigest, transactionHash: input.transactionHash,
      requiredConfirmations: input.requiredConfirmations };
    evaluateGeneralTransferEvidence({ ...base, receipt: null, canonicalBlockHash: null, headBlockNumber: null });
    requireWallet(!this.shutdown.signal.aborted && !this.active && activeReaders < 2,
      "GENERAL_OPERATION_BUSY", "Transaction observation is unavailable or busy.");
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(20000), ...(input.signal ? [input.signal] : [])]);
    const pending = new Set<Promise<unknown>>();
    this.active = true; activeReaders++;
    const call = async (method: string, params: readonly unknown[]): Promise<unknown> => {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
      if (bounded.aborted) return fail();
      let cancel = () => {};
      const stopped = new Promise<never>((_, reject) => {
        cancel = () => reject(new WalletError("GENERAL_EVIDENCE_UNAVAILABLE", "The transaction observation is unavailable."));
        bounded.addEventListener("abort", cancel, { once: true });
        if (bounded.aborted) cancel();
      });
      const work = Promise.resolve().then(() => { if (bounded.aborted) return fail(); return this.rpc.call(method, params, bounded); });
      pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work));
      try { return await Promise.race([work, stopped]); } finally { bounded.removeEventListener("abort", cancel); }
    };
    const chain = async () => requireWallet(quantity(await call("eth_chainId", [])) === String(network.chainId),
      "GENERAL_EVIDENCE_UNAVAILABLE", "The transaction RPC network is invalid.");
    try {
      await chain();
      const raw = await call("eth_getTransactionReceipt", [base.transactionHash]);
      if (raw === null) { await chain(); if (signal.aborted) return fail(); return { evidence: { status: "UNKNOWN" }, nodeFinalized: null }; }
      const observed = receipt(raw, network.chainId), tag = `0x${BigInt(observed.blockNumber).toString(16)}`;
      const before = block(await call("eth_getBlockByNumber", [tag, false]));
      const head = block(await call("eth_getBlockByNumber", ["latest", false]));
      const finalized = includeFinalized ? block(await call("eth_getBlockByNumber", ["finalized", false])) : null;
      const finalizedTag = finalized ? `0x${BigInt(finalized.number).toString(16)}` : null;
      const finalizedBefore = finalizedTag ? block(await call("eth_getBlockByNumber", [finalizedTag, false])) : null;
      const after = block(await call("eth_getBlockByNumber", [tag, false]));
      const finalizedAfter = finalizedTag ? block(await call("eth_getBlockByNumber", [finalizedTag, false])) : null;
      const latestFinalized = includeFinalized ? block(await call("eth_getBlockByNumber", ["finalized", false])) : null;
      await chain();
      requireWallet(!signal.aborted && before.number === observed.blockNumber && after.number === observed.blockNumber,
        "GENERAL_EVIDENCE_UNAVAILABLE", "The observed block is unavailable.");
      if (finalized && finalizedBefore && finalizedAfter && latestFinalized) {
        requireWallet(finalizedBefore.number === finalized.number && finalizedAfter.number === finalized.number &&
          finalizedBefore.hash === finalized.hash && finalizedAfter.hash === finalized.hash &&
          BigInt(finalized.number) <= BigInt(head.number) && BigInt(latestFinalized.number) >= BigInt(finalized.number) &&
          (latestFinalized.number !== finalized.number || latestFinalized.hash === finalized.hash) &&
          (finalized.number !== observed.blockNumber || finalized.hash === after.hash),
        "GENERAL_EVIDENCE_UNAVAILABLE", "The node's reported finalized block changed.");
      }
      const result = evaluateGeneralTransferEvidence({ ...base, receipt: observed, canonicalBlockHash: after.hash, headBlockNumber: head.number });
      if (before.hash !== after.hash || result.status === "REORGED") return { evidence: { status: "REORGED" }, nodeFinalized: null };
      return { evidence: result, nodeFinalized: finalized ? { blockNumber: finalized.number, blockHash: finalized.hash,
        relation: BigInt(observed.blockNumber) <= BigInt(finalized.number) ? "receipt_at_or_before_tag" : "receipt_after_tag" } : null };
    } catch (error) {
      if (error instanceof WalletError && (error.code === "GENERAL_EVIDENCE_INVALID" || error.code === "LEGACY_NETWORK_RESERVED")) throw error;
      return fail();
    } finally {
      const release = () => { this.active = false; activeReaders--; };
      if (pending.size) void Promise.allSettled(pending).then(release); else release();
    }
  }

  close(): void { this.shutdown.abort(); }
}
