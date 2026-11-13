import { randomUUID } from "node:crypto";
import type { PaymentIntent, WalletLimits } from "../domain/model.js";
import type { WalletInfo } from "./runtimeTypes.js";
import type { GuardedWalletState } from "./guardedState.js";
import type { WalletRecord, WalletState } from "./state.js";
import type { KeyCustody, WalletChain } from "./ports.js";
import type { TrustedWalletClock } from "./clock.js";
import type { WalletUnlocks } from "./unlock.js";
import type { WalletSessions } from "./sessions.js";
import type { SecurityFence } from "./securityFence.js";
import type { WalletControls } from "./controls.js";
import { requireWallet } from "../domain/errors.js";
export interface RuntimeContext {
  paymentNetwork: import("../domain/model.js").Network;
  state: GuardedWalletState;
  custody: KeyCustody;
  chain: WalletChain;
  clock: TrustedWalletClock;
  unlocks: WalletUnlocks;
  sessions: WalletSessions;
  fence: SecurityFence;
  controls: WalletControls;
  generalSources?: { ready(): boolean; upgrade(): { backupPath: string } };
}
export function walletRecord(state: WalletState, walletId: string): WalletRecord {
  const wallet = state.wallets.find((item) => item.walletId === walletId);
  requireWallet(wallet, "WALLET_NOT_FOUND", "The managed wallet does not exist.");
  return wallet;
}
export function walletInfo(
  ctx: RuntimeContext,
  wallet: WalletRecord,
  locked?: boolean,
  state = ctx.state.snapshot(),
): WalletInfo {
  const subject = state.subjects.find((s) => s.subjectId === wallet.subjectId)!;
  return {
    walletId: wallet.walletId,
    subjectId: wallet.subjectId,
    address: wallet.address,
    network: wallet.network,
    asset: wallet.asset,
    isDefault: state.defaultWalletId === wallet.walletId,
    locked: locked ?? !ctx.unlocks.isUnlocked(wallet.walletId),
    recoveryRequired: !ctx.state.continuityValid() || subject.recoveryRequired,
    signingPaused: subject.signingPaused,
  };
}
export function disabledLimits(): WalletLimits {
  return {
    maxPerPaymentAtomic: "0",
    maxRolling24hAtomic: "0",
    maxCumulativeAtomic: "0",
    enabled: false,
    version: 1,
  };
}
export function audit(
  state: WalletState,
  action: string,
  subjectId: string | null,
  details: Record<string, string | number | boolean | null> = {},
): void {
  state.auditEvents.push({
    eventId: randomUUID(),
    action,
    subjectId,
    recordedAt: state.trustedTime,
    details,
  });
}

/** Persist contrary chain evidence once, without changing the financial reservation. */
export function recordWaiverContradiction(state: WalletState, intent: PaymentIntent | undefined): void {
  if (intent?.schedulingRelease?.kind !== "waived") return;
  delete intent.schedulingRelease;
  if (intent.waiverContradicted) return;
  intent.waiverContradicted = true;
  audit(state, "PAYMENT_WAIVER_BROKEN", intent.subjectId, { intentId: intent.intentId });
}
