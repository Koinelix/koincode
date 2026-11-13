import type { RuntimeContext } from "./runtimeContext.js";
import { audit } from "./runtimeContext.js";
import { outstandingAtSnapshot } from "./settlementProof.js";
import { assertUnsignedRetry } from "./unsignedRetry.js";
import { cappedAllowance, pendingAllowanceChange } from "./walletAllowance.js";
import { replacementGrant } from "./paymentReplacement.js";
import { randomUUID } from "node:crypto";
import { requireWallet, WalletError } from "../domain/errors.js";
import { uptoAvailability, type ModelDirectPayment } from "../domain/uptoScheduling.js";
import { checkGrant } from "../domain/grants.js";
import { checkBudget } from "../domain/budget.js";
import type { ClientHandle } from "./sessions.js";
import type { WalletState, WalletRecord } from "./state.js";
import type { ChainSnapshot } from "./ports.js";
import type { PaymentGrant, PaymentScope, PaymentIntent, ExactAuthorization } from "../domain/model.js";
import type { UptoAuthorization } from "../domain/uptoAuthorization.js";

/** Called in the ledger mutation after the original signer rechecks its control and unlock fences. */
export function reservePayment(state: WalletState, input: {
  ctx: RuntimeContext; initial: WalletState; wallet: WalletRecord; handle: ClientHandle; scope: PaymentScope;
  snapshot: ChainSnapshot; proven: ReadonlySet<string>; now: number; timeoutCap: number; shared: boolean; direct?: ModelDirectPayment;
  authorization: Readonly<ExactAuthorization>; upto?: UptoAuthorization; constraints?: { replacementFrom?: string; unsignedRetryFrom?: string };
  pickGrant(): PaymentGrant;
}) {
  const { ctx, initial, wallet, handle, scope, snapshot, proven, now, timeoutCap, shared, authorization, upto, constraints, pickGrant } = input;
  if (upto) {
    const pending = pendingAllowanceChange(state, wallet.subjectId);
    const chain = cappedAllowance(snapshot as import("./ports.js").UptoChainSnapshot, pending);
    requireWallet(!pending || upto.upto.permitNonce === null, "PAYMENT_QUEUE_REQUIRED", "An allowance change is pending.");
    // Payments admitted side by side reserve during each other's chain read. The availability below is
    // recomputed from the current ledger, where a reservation unknown to this snapshot counts in full.
    const observed = (ledger: typeof state) => JSON.stringify([shared ? [] : ledger.intents.filter(item => item.subjectId === scope.subjectId), ledger.policies[scope.subjectId]]);
    requireWallet(observed(state) === observed(initial), "PAYMENT_CONTEXT_CHANGED", "The ledger changed during allowance observation; retry before signing.");
    const intents = state.intents.filter(item => item.subjectId === scope.subjectId && item.upto);
    const available = uptoAvailability(intents, { ...chain, finalizedTimestamp: snapshot.finalized.timestamp },
      upto.upto.permitNonce === null ? input.direct : undefined, upto.validAfter);
    requireWallet(upto.payer === wallet.address && upto.network === scope.network && upto.asset === scope.asset &&
      upto.payTo === scope.payTo && upto.amountAtomic === scope.amountAtomic, "PERMIT_MISMATCH", "The upto quote changed before reservation.");
    requireWallet(!available.permitPending && (upto.upto.permitNonce === null ? available.availableAtomic >= BigInt(scope.amountAtomic) :
      available.inFlightAtomic === 0n && upto.upto.permitNonce === chain.permitNonce),
      "PAYMENT_QUEUE_REQUIRED", "The allowance or permit admission changed before signing.");
  }
  const context = ctx.sessions.requireSubject(handle, scope.subjectId, state);
  const existing = state.intents.find(
    (intent) => intent.clientId === context.clientId && intent.requestId === scope.requestId,
  );
  if (constraints?.unsignedRetryFrom)
    assertUnsignedRetry(state, scope, context.clientId, constraints.unsignedRetryFrom);
  if (existing && !constraints?.replacementFrom && !constraints?.unsignedRetryFrom) {
    requireWallet(
      [
        "scheme",
        "requestDigest",
        "quoteDigest",
        "credentialVersion",
        "subjectId",
        "origin",
        "path",
        "method",
        "network",
        "asset",
        "payTo",
        "amountAtomic",
      ].every(
        (key) => existing[key as keyof PaymentScope] === scope[key as keyof PaymentScope],
      ),
      "REQUEST_CONFLICT",
      "The request already has a different frozen purchase.",
    );
    throw new WalletError(
      "PAYMENT_ALREADY_STARTED",
      "This purchase already has a persisted payment intent.",
    );
  }
  requireWallet(!state.intents.some(intent => intent.network === authorization.network &&
    intent.asset.toLowerCase() === authorization.asset.toLowerCase() &&
    intent.nonce.toLowerCase() === authorization.nonce &&
    state.subjects.some(subject => subject.subjectId === intent.subjectId &&
      subject.address.toLowerCase() === authorization.payer)),
  "AUTHORIZATION_NONCE_ALREADY_USED", "The authorization nonce already belongs to a recorded payment.");
  const reserved = outstandingAtSnapshot(state, wallet.walletId, snapshot, proven);
  requireWallet(BigInt(snapshot.balanceAtomic) >= reserved + BigInt(scope.amountAtomic),
    "INSUFFICIENT_BALANCE", "The anchored balance is insufficient for existing reservations and this payment.");
  const subject = state.subjects.find((subject) => subject.subjectId === scope.subjectId)!;
  const policy = state.policies[scope.subjectId]!;
  checkBudget(subject, policy, state.events, scope.amountAtomic, now);
  const replaced = constraints?.replacementFrom
    ? state.intents.find(
        (x) =>
          x.intentId === constraints.replacementFrom &&
          x.clientId === context.clientId &&
          x.requestId === scope.requestId,
      )
    : undefined;
  requireWallet(
    !constraints?.replacementFrom || replaced,
    "PERMIT_MISMATCH",
    "The original replacement authorization is unavailable.",
  );
  const grant = replaced
    ? replacementGrant(state, replaced, scope)
    : pickGrant();
  if (replaced && grant.scope === "once")
    requireWallet(
      timeoutCap <= (replaced.authorizedTimeoutSeconds ?? 120),
      "PAYMENT_APPROVAL_REQUIRED",
      "The replacement expands the original signing timeout.",
    );
  if (replaced) checkGrant(grant, scope, context, state.managementEpoch, now, ctx.sessions.hostGrantScope(handle));
  const intent: PaymentIntent = {
    ...scope,
    ...(upto ? { upto: structuredClone(upto.upto), actualAmountAtomic: null } : {}),
    intentId: randomUUID(),
    ...(replaced ? { replacesIntentId: replaced.intentId } : {}),
    authorizedTimeoutSeconds: timeoutCap,
    walletId: wallet.walletId,
    clientId: context.clientId,
    sessionId: context.sessionId,
    generation: context.generation,
    grantId: grant.grantId,
    grantVersion: grant.version,
    policyVersion: policy.version,
    managementEpoch: state.managementEpoch,
    nonce: authorization.nonce,
    validAfter: authorization.validAfter,
    validBefore: authorization.validBefore,
    anchorBlock: snapshot.latest.number,
    anchorHash: snapshot.latest.hash,
    status: "SIGNING",
    reserved: true,
    spent: false,
    settledAt: null,
    evidenceKey: null,
  };
  const permitId = randomUUID();
  state.permits.push({
    permitId,
    intentId: intent.intentId,
    requestId: scope.requestId,
    expiresAt: Math.min(authorization.validBefore - 5, now + 30),
    status: "consumed",
  });
  if (grant.scope === "once") grant.status = "consumed";
  state.intents.push(intent);
  state.events.push({
    eventId: randomUUID(),
    subjectId: scope.subjectId,
    intentId: intent.intentId,
    kind: "RESERVE",
    reservedDelta: scope.amountAtomic,
    spentDelta: "0",
    settledAt: null,
    recordedAt: now,
    evidenceKey: null,
  });
  state.trustedTime = Math.max(state.trustedTime, now);
  audit(state, "PAYMENT_SIGNING", scope.subjectId, { intentId: intent.intentId, permitId });
  return { intent, permitId };
}
