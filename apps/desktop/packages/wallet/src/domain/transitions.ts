import { positiveAtomic, timestamp } from "./atomic.js";
import { requireWallet } from "./errors.js";
import type { LedgerEvent, PaymentIntent, PaymentStatus } from "./model.js";

export interface VerifiedSettlement {
  evidenceKey: string;
  settledAt: number;
}
export function transitionIntent(
  intent: PaymentIntent,
  action:
    | "observed"
    | "confirmed"
    | "reorg"
    | "expired"
    | "canceled"
    | "cancel_reorg"
    | "expiry_reorg"
    | "failed_unsigned",
  eventId: string,
  now: number,
  evidence?: VerifiedSettlement,
): { intent: PaymentIntent; event: LedgerEvent; lateSettlement: boolean } {
  timestamp(now);
  const amount = positiveAtomic(intent.amountAtomic);
  let status: PaymentStatus = intent.status;
  let reserved = intent.reserved;
  let spent = intent.spent;
  let settledAt = intent.settledAt;
  let evidenceKey = intent.evidenceKey;
  let kind: LedgerEvent["kind"] = "RELEASE";
  let lateSettlement = false;
  if (action === "observed") {
    requireWallet(
      !spent,
      "EVIDENCE_ALREADY_APPLIED",
      "The authorization is already recorded as spent.",
    );
    requireWallet(
      intent.status !== "FAILED_UNSIGNED",
      "EVIDENCE_CONFLICT",
      "An unsigned failure cannot be settled.",
    );
    requireWallet(
      evidence && evidence.evidenceKey.length > 0,
      "EVIDENCE_REQUIRED",
      "Verified settlement evidence is required.",
    );
    timestamp(evidence.settledAt);
    requireWallet(
      evidence.settledAt <= now,
      "CHAIN_TIME_STALE",
      "Settlement is newer than the trusted clock.",
    );
    lateSettlement =
      intent.status === "EXPIRED_UNSETTLED" || intent.status === "CANCELED_UNSETTLED";
    status = "OBSERVED";
    reserved = Boolean(intent.upto);
    spent = !intent.upto;
    settledAt = evidence.settledAt;
    evidenceKey = evidence.evidenceKey;
    kind = "SPEND";
  } else if (action === "confirmed") {
    requireWallet(
      intent.status === "OBSERVED" && (spent || Boolean(intent.upto)),
      "INVALID_TRANSITION",
      "Only an observed payment can be confirmed.",
    );
    status = "CONFIRMED";
    reserved = false;
    spent = true;
    kind = "SPEND";
  } else if (action === "reorg") {
    requireWallet(
      (spent || intent.status === "OBSERVED" && Boolean(intent.upto)) && settledAt !== null,
      "INVALID_TRANSITION",
      "Only an included payment can be removed.",
    );
    status = "SUBMITTED";
    spent = false;
    reserved = true;
    kind = "REORG";
  } else if (action === "cancel_reorg" || action === "expiry_reorg") {
    requireWallet(
      intent.status === (action === "cancel_reorg" ? "CANCELED_UNSETTLED" : "EXPIRED_UNSETTLED"),
      "INVALID_TRANSITION",
      "Only a canceled proof can be removed.",
    );
    status = "UNKNOWN";
    reserved = true;
    kind = "RESTORE_RESERVATION";
  } else if (action === "failed_unsigned") {
    requireWallet(
      intent.status === "RESERVED",
      "INVALID_TRANSITION",
      "A possible signature cannot be released as unsigned.",
    );
    status = "FAILED_UNSIGNED";
    reserved = false;
  } else {
    requireWallet(
      reserved && !spent && intent.status !== "RESERVED",
      "INVALID_TRANSITION",
      "The authorization has no unresolved signature risk.",
    );
    if (action === "expired") {
      requireWallet(
        now > intent.validBefore,
        "AUTHORIZATION_NOT_EXPIRED",
        "The authorization has not expired at the verified proof time.",
      );
    }
    status = action === "expired" ? "EXPIRED_UNSETTLED" : "CANCELED_UNSETTLED";
    reserved = false;
  }
  const reservedDelta = (BigInt(Number(reserved)) - BigInt(Number(intent.reserved))) * amount;
  const spentAmount = intent.upto && (spent || intent.spent) ? positiveAtomic(intent.actualAmountAtomic!) : amount;
  requireWallet(spentAmount <= amount, "RPC_EVIDENCE_INVALID", "Settlement exceeds the authorized maximum.");
  const spentDelta = (BigInt(Number(spent)) - BigInt(Number(intent.spent))) * spentAmount;
  return {
    intent: { ...intent, status, reserved, spent, settledAt, evidenceKey },
    lateSettlement,
    event: {
      eventId,
      subjectId: intent.subjectId,
      intentId: intent.intentId,
      kind,
      reservedDelta: reservedDelta.toString(),
      spentDelta: spentDelta.toString(),
      settledAt: spentDelta === 0n ? null : settledAt,
      recordedAt: now,
      evidenceKey: evidence?.evidenceKey ?? null,
    },
  };
}
