import { randomUUID } from "node:crypto";
import type { ClientHandle } from "./sessions.js";
import type { FrozenRequest, RequestRecord } from "../domain/requestModel.js";
import { requireWallet } from "../domain/errors.js";
import { RequestStore } from "./requestStore.js";
import { RequestPayment } from "./requestPayment.js";
export async function prepareReplacement(
  store: RequestStore,
  payment: RequestPayment,
  handle: ClientHandle,
  parent: RequestRecord,
): Promise<RequestRecord | null> {
  const frozen = await store.frozen(parent),
    state = store.ctx.state.snapshot(),
    intent = state.intents.findLast(
      (x) => x.requestId === parent.requestId && x.clientId === parent.clientId,
    );
  requireWallet(
    intent &&
      intent.status === "EXPIRED_UNSETTLED" &&
      !intent.reserved &&
      !intent.spent &&
      parent.httpStatus === 402 &&
      parent.quoteRef &&
      parent.signedChallengeValid === true &&
      parent.action === "request" &&
      frozen.paymentMode === "policy" &&
      !parent.canceled,
    "PAYMENT_RECONCILIATION_REQUIRED",
    "The original signed risk is not eligible for quote refresh.",
  );
  const policy = store.replayPolicy(frozen);
  requireWallet(
    policy && policy.safeReplay && policy.expiresAt > store.env.wall() && frozen.businessKey,
    "QUOTE_REFRESH_REQUIRED",
    "A current trusted same-key replay contract is required.",
  );
  store.assertCurrent(handle, parent, frozen);
  if (parent.internalRefreshId) return store.owned(handle, parent.internalRefreshId);
  requireWallet(
    parent.replacementCount === 0 && !intent.replacesIntentId,
    "PAYMENT_APPROVAL_REQUIRED",
    "The single automatic replacement has already been used.",
  );
  const childFrozen: FrozenRequest = { ...frozen, paymentMode: "never" };
  const frozenRef = await store.putJson(childFrozen);
  const { requestDigest } = await import("./requestFacts.js");
  return store.ctx.state.mutate((next) => {
    store.ctx.sessions.resolve(handle, next);
    const t = next.transport!,
      current = t.requests.find((x) => x.requestId === parent.requestId)!;
    requireWallet(
      !current.canceled && current.replacementCount === 0,
      "WALLET_OPERATION_ABORTED",
      "The parent request can no longer refresh.",
    );
    if (current.internalRefreshId)
      return t.requests.find((x) => x.requestId === current.internalRefreshId)!;
    const child: RequestRecord = {
      ...parent,
      requestId: randomUUID(),
      operationId: randomUUID(),
      inputDigest: requestDigest({ internalRefreshOf: parent.requestId }),
      frozenRef,
      frozenDigest: requestDigest(childFrozen),
      parentRequestId: parent.requestId,
      action: "refresh_quote",
      replayPolicyDigest: requestDigest(policy),
      createdAt: store.env.wall(),
      expiresAt: parent.expiresAt,
      transportStatus: "prepared",
      paymentStatus: "not_required",
      intentIds: [],
      canceled: false,
      replacementCount: 0,
    };
    for (const key of [
      "quoteRef",
      "responseRef",
      "responseRetentionId",
      "bodyRef",
      "payloadRef",
      "paymentIntentId",
      "amountAtomic",
      "network",
      "transactionHash",
      "httpStatus",
      "responseHeaders",
      "byteLength",
      "sha256",
      "diagnosticCode",
      "internalRefreshId",
      "replacementFrom",
    ] as const)
      delete child[key];
    t.requests.push(child);
    current.internalRefreshId = child.requestId;
    return child;
  });
}
export async function consumeReplacement(
  store: RequestStore,
  payment: RequestPayment,
  handle: ClientHandle,
  id: string,
  childId: string,
): Promise<RequestRecord | null> {
  const parent = store.owned(handle, id),
    child = store.owned(handle, childId),
    frozen = await store.frozen(parent),
    childFrozen = await store.frozen(child);
  requireWallet(
    parent.internalRefreshId === childId &&
      child.parentRequestId === id &&
      child.action === "refresh_quote" &&
      childFrozen.paymentMode === "never" &&
      childFrozen.url === frozen.url &&
      childFrozen.body === frozen.body &&
      childFrozen.businessKey === frozen.businessKey &&
      childFrozen.credentialVersion === frozen.credentialVersion,
    "REQUEST_CONFLICT",
    "The registered quote refresh does not belong to this purchase.",
  );
  requireWallet(
    child.transportStatus === "completed",
    "QUOTE_REFRESH_REQUIRED",
    "The registered refresh outcome is not complete.",
  );
  if (child.httpStatus !== 402) {
    await store.update(id, (r) => {
      r.relatedRequestId = childId;
      r.diagnosticCode = "QUOTE_REFRESH_BUSINESS_RESULT";
      r.transportStatus = "completed";
    });
    return null;
  }
  let next = await store.quote(child);
  const old = await store.quote({ ...parent, quoteRef: parent.signedQuoteRef ?? parent.quoteRef });
  payment.fresh(next);
  const previous = store.ctx.state.snapshot().intents.findLast((x) => x.requestId === id),
    grant = store.ctx.state.snapshot().grants.find((x) => x.grantId === previous?.grantId);
  next = payment.select(handle, parent, frozen, next, grant?.scope === "once" ? old : undefined);
  payment.validateReplacement(old, next, grant?.scope === "once");
  const selectedQuoteRef = await store.putJson(next);
  store.assertCurrent(handle, parent, frozen);
  return store.ctx.state.mutate((state) => {
    const t = state.transport!,
      current = t.requests.find((x) => x.requestId === id)!,
      record = t.requests.find((x) => x.requestId === childId)!;
    const original = state.intents.findLast(
      (x) => x.requestId === id && x.clientId === current.clientId,
    );
    requireWallet(
      current.internalRefreshId === childId &&
        current.replacementCount === 0 &&
        !current.canceled &&
        original?.status === "EXPIRED_UNSETTLED" &&
        !original.reserved &&
        !original.spent &&
        record.quoteRef === child.quoteRef,
      "PAYMENT_RECONCILIATION_REQUIRED",
      "The refresh was already consumed or the original risk changed.",
    );
    current.replacementCount = 1;
    current.replacementFrom = original.intentId;
    current.quoteRef = selectedQuoteRef;
    current.amountAtomic = next.selected.amount;
    current.network = next.selected.network;
    current.transportStatus = "awaiting_authorization";
    delete current.diagnosticCode;
    return current;
  });
}
