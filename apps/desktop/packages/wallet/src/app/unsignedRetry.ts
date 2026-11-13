import type { WalletState } from "./state.js";
import type { PaymentScope } from "../domain/model.js";
import { requireWallet } from "../domain/errors.js";
export function assertUnsignedRetry(
  state: WalletState,
  scope: PaymentScope,
  clientId: string,
  from: string,
): void {
  const previous = state.intents.filter(
    (i) => i.requestId === scope.requestId && i.clientId === clientId,
  );
  requireWallet(
    previous.length > 0 &&
      previous.at(-1)?.intentId === from &&
      previous.every(
        (i) =>
          i.status === "FAILED_UNSIGNED" &&
          !i.reserved &&
          !i.spent &&
          i.managementEpoch === state.managementEpoch &&
          i.requestDigest === scope.requestDigest &&
          i.subjectId === scope.subjectId &&
          i.credentialVersion === scope.credentialVersion &&
          i.origin === scope.origin &&
          i.path === scope.path &&
          i.method === scope.method,
      ),
    "PAYMENT_RECONCILIATION_REQUIRED",
    "Only an explicitly proven unsigned purchase can obtain a new precise permit.",
  );
}
