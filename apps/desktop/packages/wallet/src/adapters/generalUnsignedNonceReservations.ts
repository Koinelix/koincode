import { requireWallet } from "../domain/errors.js";
import { assertGeneralBoundedManualFee } from "../domain/generalSigningPolicy.js";
import { consumeGeneralPendingNonce } from "./generalPendingNonce.js";
import type { GeneralSigningRisk } from "../app/generalSigningTypes.js";
import { consumeGeneralTransferFunds } from "./generalTransferFundsEvidence.js";
import { consumeGeneralTransferApproval } from "./generalTransferApproval.js";
import { consumeGeneralTransferSimulation } from "./generalTransferSimulation.js";
import { consumeGeneralTransferIntent } from "./generalTransferIntentStore.js";
import type { ProtectedStore } from "../app/ports.js";

/** In-memory unsigned slots owned and serialized exclusively by one signing journal. */
export class GeneralUnsignedNonceReservations {
  private readonly slots = new Map<string, { ticket: object; nonce: number; expiresAt: number }>();

  reserve(streamId: string, account: string, networkId: string, evidence: object, now: number): { nonce: number; reservation: object } {
    assertGeneralBoundedManualFee(networkId);
    requireWallet(Number.isSafeInteger(now) && now >= 0 && now <= Number.MAX_SAFE_INTEGER - 60000,
      "SIGNING_CONTINUITY_UNKNOWN", "The signing clock is unavailable.");
    const { nonce } = consumeGeneralPendingNonce(evidence, account, networkId, now);
    for (const [id, slot] of this.slots) {
      if (now >= slot.expiresAt || now < slot.expiresAt - 60000) this.slots.delete(id);
    }
    requireWallet(!this.slots.has(streamId) && this.slots.size < 256,
      "GENERAL_OPERATION_BUSY", "An unsigned transfer is already being prepared.");
    const ticket = Object.freeze({});
    this.slots.set(streamId, { ticket, nonce, expiresAt: now + 60000 });
    return { nonce, reservation: ticket };
  }

  async assert(streamId: string, ticket: object, evidence: object, funds: object, approval: object, simulation: object, intent: object,
    protection: ProtectedStore, ownerId: string, risk: GeneralSigningRisk, now: number): Promise<{
    startedAt: number; expiresAt: number; isLive: () => boolean;
  }> {
    const slot = this.slots.get(streamId);
    const pending = consumeGeneralPendingNonce(evidence, risk.accountAddress, risk.networkId, now);
    requireWallet(slot && slot.ticket === ticket && pending.nonce === slot.nonce &&
      risk.nonce === slot.nonce && now < slot.expiresAt && now >= slot.expiresAt - 60000,
    "SIGNING_CONTINUITY_UNKNOWN", "The unsigned nonce reservation is unavailable or stale.");
    const balance = consumeGeneralTransferFunds(funds, ownerId, risk, now);
    const consent = consumeGeneralTransferApproval(approval, ownerId, risk, now);
    const simulated = consumeGeneralTransferSimulation(simulation, ownerId, risk, now);
    requireWallet(consent.feeObservation.networkId === simulated.feeObservation.networkId &&
      consent.feeObservation.gasPriceAtomic === simulated.feeObservation.gasPriceAtomic &&
      consent.feeObservation.baseFeePerGasAtomic === simulated.feeObservation.baseFeePerGasAtomic &&
      consent.feeObservation.priorityFeePerGasAtomic === simulated.feeObservation.priorityFeePerGasAtomic &&
      consent.gasObservation.networkId === simulated.observation.networkId &&
      consent.gasObservation.gasUnits === simulated.observation.gasUnits &&
      consent.gasObservation.feeAtPreviewGasPriceAtomic === simulated.observation.feeAtPreviewGasPriceAtomic &&
      consent.gasObservation.certainty === simulated.observation.certainty,
    "GENERAL_FEE_CHANGED", "The observed fee or gas estimate changed and requires a new confirmation.");
    await consumeGeneralTransferIntent(intent, protection, ownerId, risk);
    return { startedAt: Math.max(pending.startedAt, balance.startedAt, consent.startedAt, simulated.startedAt), expiresAt: Math.min(pending.expiresAt, balance.expiresAt, consent.expiresAt, simulated.expiresAt),
      isLive: () => pending.isLive() && balance.isLive() && consent.isLive() && simulated.isLive() };
  }

  take(streamId: string, ticket: object): void {
    requireWallet(this.slots.get(streamId)?.ticket === ticket, "SIGNING_CONTINUITY_UNKNOWN", "The unsigned reservation is unavailable.");
    this.slots.delete(streamId);
  }

  cancel(ticket: object): void {
    const item = [...this.slots.entries()].find(([, value]) => value.ticket === ticket);
    requireWallet(item, "SIGNING_CONTINUITY_UNKNOWN", "The unsigned reservation is unavailable.");
    this.slots.delete(item[0]);
  }

  clear(): void { this.slots.clear(); }
}
