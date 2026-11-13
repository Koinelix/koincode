import { requireWallet } from "../domain/errors.js";
import { GeneralTransferNonceObservationReader, type GeneralNonceObservation } from "./generalTransferNonceObservation.js";
import { GeneralTransferRecoveryReader } from "./generalTransferRecovery.js";

/** Explicitly observes one protected risk and never changes or releases it. */
export class GeneralTransferRecoveryNonce {
  constructor(private readonly recovery: GeneralTransferRecoveryReader, private readonly nonce: GeneralTransferNonceObservationReader) {}

  async read(input: { accountAddress: string; networkId: string; offset: number; head: string; riskId: string; signal: AbortSignal }): Promise<{
    riskId: string; observation: GeneralNonceObservation;
  }> {
    requireWallet(!input.signal.aborted && /^[0-9a-f]{64}$/.test(input.head), "GENERAL_EVIDENCE_UNAVAILABLE", "The nonce observation is unavailable.");
    const first = await this.recovery.read(input.accountAddress, input.networkId, input.offset, 1, input.head), original = first.items[0];
    requireWallet(original?.risk.riskId === input.riskId && original.intent && !input.signal.aborted,
      "GENERAL_EVIDENCE_UNAVAILABLE", "The selected risk is unavailable.");
    const observation = await this.nonce.read(original.intent, input.signal);
    requireWallet(!input.signal.aborted, "GENERAL_EVIDENCE_UNAVAILABLE", "The nonce observation was canceled.");
    const second = await this.recovery.read(input.accountAddress, input.networkId, input.offset, 1, input.head), current = second.items[0];
    requireWallet(!input.signal.aborted && current?.risk.riskId === input.riskId && current.intent?.digest === original.intent.digest &&
      observation.accountAddress === input.accountAddress && observation.networkId === input.networkId &&
      observation.transactionNonce === current.risk.nonce, "SIGNING_CONTINUITY_CONFLICT", "The observed risk changed.");
    return { riskId: input.riskId, observation };
  }
}
