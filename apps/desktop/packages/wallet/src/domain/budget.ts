import { atomic, positiveAtomic, signedAtomic, timestamp } from "./atomic.js";
import { requireWallet } from "./errors.js";
import type { BudgetSubject, BudgetView, LedgerEvent, WalletLimits } from "./model.js";

export function budgetView(
  subject: BudgetSubject,
  limits: WalletLimits,
  events: readonly LedgerEvent[],
  trustedNow: number,
): BudgetView {
  timestamp(trustedNow);
  const rollingLimit = atomic(limits.maxRolling24hAtomic);
  const cumulativeLimit = atomic(limits.maxCumulativeAtomic);
  atomic(limits.maxPerPaymentAtomic);
  let reserved = 0n;
  let spent = 0n;
  let rolling = 0n;
  const seen = new Set<string>();
  for (const event of events) {
    if (event.subjectId !== subject.subjectId) continue;
    requireWallet(!seen.has(event.eventId), "LEDGER_CORRUPT", "Duplicate ledger event.");
    seen.add(event.eventId);
    timestamp(event.recordedAt);
    reserved += signedAtomic(event.reservedDelta);
    const delta = signedAtomic(event.spentDelta);
    spent += delta;
    if (delta !== 0n) {
      requireWallet(
        event.settledAt !== null,
        "LEDGER_CORRUPT",
        "Spent events require a canonical timestamp.",
      );
      timestamp(event.settledAt);
      requireWallet(
        event.settledAt <= trustedNow,
        "CHAIN_TIME_STALE",
        "The trusted clock precedes settlement evidence.",
      );
      if (event.settledAt > trustedNow - 86400) rolling += delta;
    }
  }
  requireWallet(
    reserved >= 0n && spent >= 0n && rolling >= 0n,
    "LEDGER_CORRUPT",
    "Ledger totals must remain nonnegative.",
  );
  const remaining = (value: bigint) => (value > 0n ? value : 0n).toString();
  return {
    reservedAtomic: reserved.toString(),
    rolling24hSpentAtomic: rolling.toString(),
    cumulativeSpentAtomic: spent.toString(),
    rolling24hRemainingAtomic: remaining(rollingLimit - rolling - reserved),
    cumulativeRemainingAtomic: remaining(cumulativeLimit - spent - reserved),
    blocked:
      !limits.enabled ||
      subject.recoveryRequired ||
      subject.signingPaused ||
      rolling + reserved > rollingLimit ||
      spent + reserved > cumulativeLimit,
  };
}

export function checkBudget(
  subject: BudgetSubject,
  limits: WalletLimits,
  events: readonly LedgerEvent[],
  amount: string,
  trustedNow: number,
): BudgetView {
  const value = positiveAtomic(amount);
  const view = budgetView(subject, limits, events, trustedNow);
  requireWallet(
    !subject.recoveryRequired,
    "WALLET_RECOVERY_REQUIRED",
    "Wallet history must be recovered before payment.",
  );
  requireWallet(!subject.signingPaused, "WALLET_SIGNING_PAUSED", "New signatures are paused.");
  requireWallet(limits.enabled, "PAYMENTS_DISABLED", "Payments have not been enabled.");
  requireWallet(
    value <= atomic(limits.maxPerPaymentAtomic),
    "PER_PAYMENT_LIMIT_EXCEEDED",
    "The per-payment limit would be exceeded.",
  );
  requireWallet(
    BigInt(view.rolling24hSpentAtomic) + BigInt(view.reservedAtomic) + value <=
      atomic(limits.maxRolling24hAtomic),
    "ROLLING_24H_LIMIT_EXCEEDED",
    "The rolling limit would be exceeded.",
  );
  requireWallet(
    BigInt(view.cumulativeSpentAtomic) + BigInt(view.reservedAtomic) + value <=
      atomic(limits.maxCumulativeAtomic),
    "CUMULATIVE_LIMIT_EXCEEDED",
    "The cumulative limit would be exceeded.",
  );
  return view;
}
