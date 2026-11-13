import type { PaymentIntent, PaymentScope } from "./model.js";
import { atomic } from "./atomic.js";

export interface UptoSchedulingObservation {
  allowanceAtomic: string;
  permitNonce: string;
  finalizedTimestamp: number;
  usedNonces: readonly string[];
}

export interface ModelDirectPayment {
  scope: PaymentScope;
  walletId: string;
  facilitator: string;
  modelIntentIds: ReadonlySet<string>;
}

function outsideDirectWindow(intent: PaymentIntent, direct: ModelDirectPayment, validAfter: number) {
  const { scope } = direct;
  return intent.status === "SUBMITTED" && intent.reserved && !intent.spent && !intent.waiverContradicted &&
    !intent.schedulingRelease && intent.billRequestId === undefined && intent.billAmountAtomic === undefined &&
    intent.actualAmountAtomic == null && intent.settlementBlock === undefined && intent.validBefore < validAfter &&
    intent.upto?.permitNonce === null && intent.upto.facilitator.toLowerCase() === direct.facilitator &&
    intent.walletId === direct.walletId && intent.subjectId === scope.subjectId && intent.network === scope.network &&
    intent.asset.toLowerCase() === scope.asset.toLowerCase() && intent.payTo.toLowerCase() === scope.payTo.toLowerCase() &&
    intent.origin === scope.origin && isPinnedModelRoute(intent) && direct.modelIntentIds.has(intent.intentId);
}

export function isPinnedModelRoute(scope: PaymentScope): boolean {
  return scope.method === "POST" && (scope.origin === "https://api.koinelix.com" || scope.origin === "http://127.0.0.1:8080") &&
    (/^\/v1\/(responses|messages|chat\/completions)$/.test(scope.path) ||
      /^\/v1beta\/models\/[a-zA-Z0-9._-]+:(streamGenerateContent|generateContent)$/.test(scope.path));
}

/** Derived from the original ledger and one canonical chain snapshot; owns no second queue or ledger. */
export function uptoAvailability(intents: readonly PaymentIntent[], observation: UptoSchedulingObservation,
  direct?: ModelDirectPayment, validAfter = 0) {
  let pastDirect = 0n;
  let allowance = atomic(observation.allowanceAtomic), inFlight = 0n, permitPending = false;
  const used = new Set(observation.usedNonces);
  const permitNonce = atomic(observation.permitNonce);
  for (const intent of intents) {
    if (!intent.upto || intent.status === "FAILED_UNSIGNED") continue;
    // The platform's recorded promise never to settle is the one release without chain evidence. It ends
    // once the nonce is consumed; the financial reservation is never affected.
    if (intent.schedulingRelease?.kind === "waived" && !intent.waiverContradicted && !used.has(intent.nonce)) continue;
    const expired = observation.finalizedTimestamp > intent.validBefore && !used.has(intent.nonce);
    // Other historical release markers are not chain evidence that a signature is unusable.
    if (!used.has(intent.nonce) && !expired) {
      const amount = atomic(intent.amountAtomic);
      inFlight += amount;
      if (direct && outsideDirectWindow(intent, direct, validAfter)) pastDirect += amount;
    }
    const nonce = intent.upto.permitNonce;
    if (nonce !== null && permitNonce <= atomic(nonce) && observation.finalizedTimestamp <= intent.validBefore) {
      permitPending = true;
      const cap = atomic(intent.amountAtomic);
      if (cap < allowance) allowance = cap;
    }
  }
  return { availableAtomic: allowance - inFlight + pastDirect, inFlightAtomic: inFlight, permitPending };
}
