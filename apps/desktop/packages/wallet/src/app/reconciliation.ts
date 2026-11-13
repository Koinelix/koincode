import { randomUUID } from "node:crypto";
import { transitionIntent } from "../domain/transitions.js";
import { budgetView } from "../domain/budget.js";
import { requireWallet } from "../domain/errors.js";
import { audit, recordWaiverContradiction, walletRecord, type RuntimeContext } from "./runtimeContext.js";
import type { SettlementResult } from "./ports.js";
import type { PaymentIntent } from "../domain/model.js";
import type { WalletState } from "./state.js";
function assertRecoveryEvidence(state: WalletState, epoch: string, intent: PaymentIntent) {
  requireWallet(state.managementEpoch === epoch &&
    JSON.stringify(state.intents.find(item => item.intentId === intent.intentId)) === JSON.stringify(intent),
    "PAYMENT_CONTEXT_CHANGED", "The payment changed during background reconciliation.");
}
type RecoveryLease = (signal: AbortSignal) => Promise<() => void>;
export class WalletReconciliation {
  #pending = new Set<string>();
  constructor(private readonly ctx: RuntimeContext) {}
  /** Full recovery reads outside model admission. Only a still-current observation may enter the write fence. */
  private async beginRecoveryWrite(lease: RecoveryLease, signal: AbortSignal, epoch: string, intent: PaymentIntent) {
    const release = await lease(signal);
    try {
      signal.throwIfAborted();
      const state = this.ctx.state.snapshot();
      requireWallet(this.ctx.state.continuityValid(), "WALLET_RECOVERY_REQUIRED", "State continuity must be recovered.");
      assertRecoveryEvidence(state, epoch, intent);
      const end = this.ctx.fence.beginControl("leased_recovery");
      this.ctx.unlocks.invalidatePending();
      return () => { end(); release(); };
    } catch (error) { release(); throw error; }
  }
  async resolve(intentId: string, signal?: AbortSignal, lease?: RecoveryLease) {
    const ctx = this.ctx;
    requireWallet(
      ctx.chain.resolveAuthorization && this.#pending.size < 16 && !this.#pending.has(intentId),
      "RPC_BUSY",
      "Authorization resolution is unavailable or busy.",
    );
    let end = lease ? undefined : ctx.fence.beginControl();
    this.#pending.add(intentId);
    if (end) ctx.unlocks.invalidatePending();
    let txHash: string | undefined;
    try {
      const state = ctx.state.snapshot(),
        intent = state.intents.find((x) => x.intentId === intentId);
      requireWallet(
        intent && intent.status !== "FAILED_UNSIGNED",
        "PAYMENT_NOT_FOUND",
        "A possible authorization is required.",
      );
      const cancel = AbortSignal.any([ctx.fence.signal, ...(signal ? [signal] : [])]);
      const result = await ctx.chain.resolveAuthorization(
        intent,
        walletRecord(state, intent.walletId).address,
        lease ? AbortSignal.any([cancel, AbortSignal.timeout(15000)]) : cancel,
      );
      if (lease) end = await this.beginRecoveryWrite(lease, cancel, state.managementEpoch, intent);
      const now = ctx.clock.update(result.trustedTime, ctx.state.snapshot().trustedTime);
      if (result.kind === "used") txHash = result.txHash;
      if (result.kind !== "used" || (intent.upto && intent.schedulingRelease?.kind === "waived"))
        await ctx.state.mutate((next) => {
          requireWallet(
            !cancel.aborted,
            "WALLET_OPERATION_ABORTED",
            "Authorization resolution was canceled.",
          );
          if (lease) assertRecoveryEvidence(next, state.managementEpoch, intent);
          const current = next.intents.find((x) => x.intentId === intentId)!;
          if (current.upto && (result.kind === "used" || ((result.kind === "pending" || result.kind === "proof_reorg") && result.uptoNonceUsed)))
            recordWaiverContradiction(next, current);
          if (result.kind === "progress") current.resolution = result.cursor;
          else if (
            result.kind === "proof_reorg" &&
            ["CANCELED_UNSETTLED", "EXPIRED_UNSETTLED"].includes(current.status)
          ) {
            const change = transitionIntent(
              current,
              current.status === "CANCELED_UNSETTLED" ? "cancel_reorg" : "expiry_reorg",
              randomUUID(),
              now,
            );
            Object.assign(current, change.intent);
            next.events.push(change.event);
            delete current.proofBlock;
            delete current.proofHash;
            delete current.resolution;
            audit(next, "AUTHORIZATION_PROOF_REORG", current.subjectId, { intentId });
          } else if (result.kind === "expired" || result.kind === "canceled") {
            requireWallet(
              result.proof.timestamp <= now &&
                (result.kind !== "expired" || result.proof.timestamp > current.validBefore),
              "RPC_EVIDENCE_INVALID",
              "The safe authorization proof time is invalid.",
            );
            if (current.reserved && !current.spent) {
              const change = transitionIntent(current, result.kind, randomUUID(), now);
              Object.assign(current, change.intent);
              next.events.push(change.event);
              current.proofBlock = result.proof.number;
              current.proofHash = result.proof.hash;
              delete current.resolution;
              audit(next, "AUTHORIZATION_SAFE_" + result.kind.toUpperCase(), current.subjectId, {
                intentId,
              });
            }
          } else if (result.kind === "pending") delete current.resolution;
          next.trustedTime = Math.max(next.trustedTime, now);
        });
    } finally {
      this.#pending.delete(intentId);
      end?.();
    }
    if (txHash) return this.settle(intentId, txHash, signal, lease);
    const current = ctx.state.snapshot().intents.find((x) => x.intentId === intentId)!;
    return { intentId, status: current.status, reserved: current.reserved, spent: current.spent };
  }
  async settle(intentId: string, txHash: string, signal?: AbortSignal, lease?: RecoveryLease) {
    const ctx = this.ctx;
    requireWallet(
      ctx.chain.settlement && this.#pending.size < 16 && !this.#pending.has(intentId),
      "RPC_BUSY",
      "Settlement verification is unavailable or already pending.",
    );
    requireWallet(
      ctx.state.continuityValid(),
      "WALLET_RECOVERY_REQUIRED",
      "State continuity must be recovered.",
    );
    let end = lease ? undefined : ctx.fence.beginControl();
    if (end) ctx.unlocks.invalidatePending();
    this.#pending.add(intentId);
    try {
      const state = ctx.state.snapshot(),
        intent = state.intents.find((intent) => intent.intentId === intentId);
      requireWallet(
        intent && intent.status !== "FAILED_UNSIGNED",
        "PAYMENT_NOT_FOUND",
        "A possible authorization is required for reconciliation.",
      );
      const wallet = walletRecord(state, intent.walletId);
      const cancel = AbortSignal.any([ctx.fence.signal, ...(signal ? [signal] : [])]);
      const readSignal = lease ? AbortSignal.any([cancel, AbortSignal.timeout(15000)]) : cancel;
      const result = await ctx.chain.settlement(intent, wallet.address, txHash, readSignal);
      if (lease) end = await this.beginRecoveryWrite(lease, cancel, state.managementEpoch, intent);
      const now = ctx.clock.update(result.trustedTime, ctx.state.snapshot().trustedTime);
      return await ctx.state.mutate((next) => {
        requireWallet(!cancel.aborted, "WALLET_OPERATION_ABORTED", "Reconciliation was canceled.");
        if (lease) assertRecoveryEvidence(next, state.managementEpoch, intent);
        let current = next.intents.find((intent) => intent.intentId === intentId)!,
          lateSettlement = false;
        const apply = (
          action: "reorg" | "observed" | "confirmed",
          evidence?: { evidenceKey: string; settledAt: number },
        ) => {
          const transition = transitionIntent(current, action, randomUUID(), now, evidence);
          Object.assign(current, transition.intent);
          next.events.push(transition.event);
          if (transition.lateSettlement)
            audit(next, "PAYMENT_LATE_SETTLEMENT", current.subjectId, { intentId });
          lateSettlement ||= transition.lateSettlement;
        };
        if (result.kind === "orphaned" && (current.spent || current.status === "OBSERVED")) {
          apply("reorg");
          delete current.schedulingRelease;
          current.actualAmountAtomic = null;
          for (const observation of next.observations)
            if (observation.intentId === intentId) observation.canonical = false;
          audit(next, "PAYMENT_REORG", current.subjectId, { intentId });
        } else if (result.kind === "used") {
          requireWallet(
            result.txHash.toLowerCase() === txHash.toLowerCase() &&
              result.block.number >= current.anchorBlock &&
              (current.upto
                ? result.block.timestamp >= current.validAfter && result.block.timestamp <= current.validBefore
                : result.block.timestamp > current.validAfter && result.block.timestamp < current.validBefore) &&
              result.block.timestamp <= now,
            "RPC_EVIDENCE_INVALID",
            "Settlement evidence conflicts with the intent.",
          );
          if (
            (current.spent || current.status === "OBSERVED") &&
            (current.settlementHash !== result.block.hash ||
              current.settledAt !== result.block.timestamp ||
              current.evidenceKey !== result.evidenceKey)
          )
            apply("reorg");
          if (current.upto) {
            requireWallet(result.actualAmountAtomic && current.billAmountAtomic === result.actualAmountAtomic && BigInt(result.actualAmountAtomic) > 0n &&
              BigInt(result.actualAmountAtomic) <= BigInt(current.amountAtomic), "RPC_EVIDENCE_INVALID", "The verified upto amount is invalid.");
            recordWaiverContradiction(next, current);
            current.actualAmountAtomic = result.actualAmountAtomic;
            current.schedulingRelease = { kind: "settled", block: { number: result.block.number, hash: result.block.hash } };
          }
          if (!current.spent && current.status !== "OBSERVED")
            apply("observed", {
              evidenceKey: result.evidenceKey,
              settledAt: result.block.timestamp,
            });
          current.settlementBlock = result.block.number;
          current.settlementHash = result.block.hash;
          current.settlementTx = result.txHash;
          const existing = next.observations.find(
            (observation) => observation.observationId === result.evidenceKey,
          );
          requireWallet(
            !existing || existing.intentId === intentId,
            "EVIDENCE_CONFLICT",
            "This chain event belongs to another payment intent.",
          );
          const observation = {
            observationId: result.evidenceKey,
            intentId,
            network: current.network,
            txHash: result.txHash.toLowerCase(),
            logIndex: result.logIndex,
            blockNumber: result.block.number,
            blockHash: result.block.hash,
            settledAt: result.block.timestamp,
            canonical: true,
            safe: result.safe,
          };
          if (existing) Object.assign(existing, observation);
          else next.observations.push(observation);
          if (result.safe && current.status === "OBSERVED") apply("confirmed");
          const subject = next.subjects.find((subject) => subject.subjectId === current.subjectId)!;
          const limits = next.policies[current.subjectId]!,
            budget = budgetView(subject, limits, next.events, now);
          if (
            lateSettlement &&
            (BigInt(current.amountAtomic) > BigInt(limits.maxPerPaymentAtomic) ||
              BigInt(budget.rolling24hSpentAtomic) + BigInt(budget.reservedAtomic) >
                BigInt(limits.maxRolling24hAtomic) ||
              BigInt(budget.cumulativeSpentAtomic) + BigInt(budget.reservedAtomic) >
                BigInt(limits.maxCumulativeAtomic))
          )
            subject.signingPaused = true;
          audit(next, "PAYMENT_CHAIN_VERIFIED", current.subjectId, { intentId, safe: result.safe });
        }
        next.trustedTime = Math.max(next.trustedTime, now);
        current = next.intents.find((intent) => intent.intentId === intentId)!;
        return {
          intentId,
          status: current.status,
          reserved: current.reserved,
          spent: current.spent,
        };
      });
    } finally {
      this.#pending.delete(intentId);
      end?.();
    }
  }
  /**
   * Read-only safe follow-up for an observed upto settlement. Confirmation only turns the full
   * reservation into an equal or smaller recorded spend, so concurrent signing budget checks stay
   * conservative and this path never enters the control fence or invalidates pending unlocks.
   * Any result that would change evidence or raise exposure is left to full reconciliation.
   * Upto signing rejects any change to the subject's other intents, so the caller passes
   * `exclusive` to run only the brief state write inside the model payment admission lease;
   * the chain read stays outside it.
   */
  async confirmObserved(intentId: string, signal: AbortSignal,
    exclusive: (write: () => Promise<void>) => Promise<void>): Promise<"confirmed" | "observed" | "unchanged"> {
    const ctx = this.ctx;
    requireWallet(ctx.chain.settlement && this.#pending.size < 16 && !this.#pending.has(intentId),
      "RPC_BUSY", "Settlement verification is unavailable or already pending.");
    requireWallet(ctx.state.continuityValid(), "WALLET_RECOVERY_REQUIRED", "State continuity must be recovered.");
    let result: SettlementResult;
    this.#pending.add(intentId);
    try {
      const state = ctx.state.snapshot(), intent = state.intents.find(item => item.intentId === intentId);
      if (!intent || !confirmable(intent)) return "unchanged";
      const wallet = walletRecord(state, intent.walletId);
      result = await ctx.chain.settlement(intent, wallet.address, intent.settlementTx!, AbortSignal.any([ctx.fence.signal, signal]));
      if (result.kind === "pending") return "observed";
      if (result.kind !== "used" || !sameEvidence(intent, result)) return "unchanged";
      if (!result.safe) return "observed";
    } finally {
      this.#pending.delete(intentId);
    }
    // The read slot is released while waiting for the lease; the write re-claims it and re-checks everything.
    const used = result;
    let outcome: "confirmed" | "unchanged" = "unchanged";
    await exclusive(async () => {
      requireWallet(this.#pending.size < 16 && !this.#pending.has(intentId), "RPC_BUSY", "Settlement verification is already pending.");
      this.#pending.add(intentId);
      try {
        const now = ctx.clock.update(used.trustedTime, ctx.state.snapshot().trustedTime);
        outcome = await ctx.state.mutate(next => {
          requireWallet(!ctx.fence.signal.aborted, "WALLET_OPERATION_ABORTED", "Reconciliation was canceled.");
          const current = next.intents.find(item => item.intentId === intentId);
          const observation = next.observations.find(item => item.observationId === used.evidenceKey);
          if (!current || !confirmable(current) || !sameEvidence(current, used) ||
            observation?.intentId !== intentId || !observation.canonical) return "unchanged";
          const transition = transitionIntent(current, "confirmed", randomUUID(), now);
          Object.assign(current, transition.intent);
          next.events.push(transition.event);
          observation.safe = true;
          audit(next, "PAYMENT_CHAIN_VERIFIED", current.subjectId, { intentId, safe: true });
          next.trustedTime = Math.max(next.trustedTime, now);
          return "confirmed" as const;
        });
      } finally {
        this.#pending.delete(intentId);
      }
    });
    return outcome;
  }
}

type UsedSettlement = Extract<SettlementResult, { kind: "used" }>;

/** An observed upto payment whose bill, actual amount and settlement evidence are all recorded. */
export function confirmable(intent: PaymentIntent): boolean {
  return Boolean(intent.upto) && intent.status === "OBSERVED" && intent.reserved && !intent.spent &&
    !!intent.settlementTx && !!intent.settlementHash && intent.settlementBlock !== undefined &&
    intent.settledAt !== null && !!intent.evidenceKey && !!intent.billAmountAtomic &&
    intent.actualAmountAtomic === intent.billAmountAtomic;
}

function sameEvidence(intent: PaymentIntent, result: UsedSettlement): boolean {
  return result.txHash.toLowerCase() === intent.settlementTx!.toLowerCase() &&
    result.block.hash === intent.settlementHash && result.block.number === intent.settlementBlock &&
    result.block.timestamp === intent.settledAt && result.evidenceKey === intent.evidenceKey &&
    result.actualAmountAtomic === intent.actualAmountAtomic;
}
