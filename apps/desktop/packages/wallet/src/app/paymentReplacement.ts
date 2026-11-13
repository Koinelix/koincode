import type { PaymentIntent, PaymentScope, PaymentGrant } from "../domain/model.js";
import type { WalletState } from "./state.js";
import { requireWallet } from "../domain/errors.js";
export function replacementGrant(
  state: WalletState,
  old: PaymentIntent,
  scope: PaymentScope,
): PaymentGrant {
  requireWallet(
    old.status === "EXPIRED_UNSETTLED" &&
      !old.reserved &&
      !old.spent &&
      !state.intents.some((x) => x.replacesIntentId === old.intentId),
    "PAYMENT_RECONCILIATION_REQUIRED",
    "Only one proven-expired authorization replacement is allowed.",
  );
  const fields = [
    "subjectId",
    "requestId",
    "requestDigest",
    "credentialVersion",
    "origin",
    "path",
    "method",
    "network",
    "asset",
  ] as const;
  requireWallet(
    fields.every((k) => scope[k] === old[k]),
    "PAYMENT_APPROVAL_REQUIRED",
    "The replacement expands the approved purchase.",
  );
  const grant = state.grants.find((x) => x.grantId === old.grantId);
  requireWallet(
    grant && grant.version === old.grantVersion && grant.managementEpoch === state.managementEpoch,
    "PAYMENT_APPROVAL_REQUIRED",
    "The original purchase authority is no longer valid.",
  );
  if (grant.scope === "once")
    requireWallet(
      scope.payTo === old.payTo && scope.amountAtomic === old.amountAtomic,
      "PAYMENT_APPROVAL_REQUIRED",
      "The one-time replacement changes commercial terms.",
    );
  // The consumed qualification continues only for this proven-safe bounded replacement, not for a new purchase.
  return grant.scope === "once" && grant.status === "consumed"
    ? { ...grant, status: "active", quoteDigest: scope.quoteDigest, expiresAt: null }
    : grant;
}
