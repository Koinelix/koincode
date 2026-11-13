import { requireWallet } from "../domain/errors.js";
import type { GeneralTransferEvidence } from "./generalTransferEvidence.js";
import { GeneralTransferObservationReader, type GeneralNodeFinalizedObservation } from "./generalTransferObservation.js";
import { GeneralTransferRecoveryReader, type GeneralRecoveryItem } from "./generalTransferRecovery.js";

function identity(item: GeneralRecoveryItem | undefined, riskId: string): { item: GeneralRecoveryItem; hash: string } {
  requireWallet(item && item.risk.riskId === riskId && item.intent && item.material !== "conflict",
    "GENERAL_EVIDENCE_UNAVAILABLE", "The selected transaction is unavailable for observation.");
  const hash = item.transactionHash ?? item.materialTransactionHash;
  requireWallet(hash, "GENERAL_EVIDENCE_UNAVAILABLE", "The original transaction hash is unavailable.");
  return { item, hash };
}

/** Explicit read-only lookup of one protected risk. Chain finality is not inferred here. */
export class GeneralTransferRecoveryObservation {
  constructor(private readonly recovery: GeneralTransferRecoveryReader, private readonly observation: GeneralTransferObservationReader) {}

  async read(input: { accountAddress: string; networkId: string; offset: number; head: string; riskId: string; signal: AbortSignal }): Promise<{
    riskId: string; transactionHash: string; evidence: GeneralTransferEvidence; finality: "not_evaluated";
  }> {
    requireWallet(!input.signal.aborted && /^[0-9a-f]{64}$/.test(input.head), "GENERAL_EVIDENCE_UNAVAILABLE", "The observation is unavailable.");
    const first = await this.recovery.read(input.accountAddress, input.networkId, input.offset, 1, input.head);
    const original = identity(first.items[0], input.riskId);
    requireWallet(!input.signal.aborted, "GENERAL_EVIDENCE_UNAVAILABLE", "The observation was canceled.");
    const result = await this.observation.read({ preview: original.item.intent!, approvedDigest: original.item.intent!.digest,
      transactionHash: original.hash, requiredConfirmations: 100000, signal: input.signal });
    requireWallet(!input.signal.aborted, "GENERAL_EVIDENCE_UNAVAILABLE", "The observation was canceled.");
    const latest = await this.recovery.read(input.accountAddress, input.networkId, input.offset, 1, input.head);
    const current = identity(latest.items[0], input.riskId);
    requireWallet(!input.signal.aborted && current.hash === original.hash && current.item.intent!.digest === original.item.intent!.digest,
      "SIGNING_CONTINUITY_CONFLICT", "The observed transaction changed.");
    const evidence: GeneralTransferEvidence = result.status === "CONFIRMED" ? { ...result, status: "MINED" } : result;
    return { riskId: input.riskId, transactionHash: original.hash, evidence, finality: "not_evaluated" };
  }

  async readNodeFinalized(input: { accountAddress: string; networkId: string; offset: number; head: string; riskId: string; signal: AbortSignal }): Promise<
    GeneralNodeFinalizedObservation & { riskId: string; transactionHash: string }> {
    requireWallet(!input.signal.aborted && /^[0-9a-f]{64}$/.test(input.head), "GENERAL_EVIDENCE_UNAVAILABLE", "The observation is unavailable.");
    const first = await this.recovery.read(input.accountAddress, input.networkId, input.offset, 1, input.head);
    const original = identity(first.items[0], input.riskId);
    requireWallet(!input.signal.aborted, "GENERAL_EVIDENCE_UNAVAILABLE", "The observation was canceled.");
    const result = await this.observation.readNodeFinalized({ preview: original.item.intent!, approvedDigest: original.item.intent!.digest,
      transactionHash: original.hash, requiredConfirmations: 100000, signal: input.signal });
    requireWallet(!input.signal.aborted, "GENERAL_EVIDENCE_UNAVAILABLE", "The observation was canceled.");
    const latest = await this.recovery.read(input.accountAddress, input.networkId, input.offset, 1, input.head);
    const current = identity(latest.items[0], input.riskId);
    requireWallet(!input.signal.aborted && current.hash === original.hash && current.item.intent!.digest === original.item.intent!.digest,
      "SIGNING_CONTINUITY_CONFLICT", "The observed transaction changed.");
    return { riskId: input.riskId, transactionHash: original.hash, ...result };
  }
}
