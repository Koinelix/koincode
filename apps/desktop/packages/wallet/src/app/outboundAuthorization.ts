import type { FrozenRequest } from "../domain/requestModel.js";
import { requireWallet } from "../domain/errors.js";
import type { ClientHandle } from "./sessions.js";
import type { RequestStore } from "./requestStore.js";
import type { OutboundAuthorizationContext, OutboundEffect } from "./requestPorts.js";
import { requestDigest } from "./requestFacts.js";

/** Project current persisted identity for the trusted host, never from model metadata. */
function outboundContext(
  store: RequestStore,
  handle: ClientHandle,
  requestId: string,
  frozen: FrozenRequest,
  stage: OutboundAuthorizationContext["stage"],
  signal: AbortSignal,
) {
  const record = store.owned(handle, requestId);
  store.assertCurrent(handle, record, frozen);
  requireWallet(
    !signal.aborted && store.env.wall() < record.expiresAt,
    "WALLET_OPERATION_ABORTED",
    "The outbound operation is canceled or expired.",
  );
  requireWallet(
    requestDigest(frozen) === record.frozenDigest,
    "REQUEST_CONTEXT_UNAVAILABLE",
    "The outbound content differs from the persisted request.",
  );
  const client = store.ctx.sessions.resolve(handle);
  const parent = record.parentRequestId ? store.owned(handle, record.parentRequestId) : null;
  const context: OutboundAuthorizationContext = Object.freeze({
    version: 1,
    requestId: record.requestId,
    operationId: record.operationId,
    inputDigest: record.inputDigest,
    frozenDigest: record.frozenDigest,
    managementEpoch: record.epoch,
    action: record.action,
    stage,
    source:
      parent?.internalRefreshId === record.requestId && record.action === "refresh_quote"
        ? "wallet_refresh"
        : "client_operation",
    createdBy: Object.freeze({ sessionId: record.sessionId, generation: record.generation }),
    parent:
      parent &&
      Object.freeze({
        requestId: parent.requestId,
        operationId: parent.operationId,
        action: parent.action,
        inputDigest: parent.inputDigest,
        frozenDigest: parent.frozenDigest,
      }),
  });
  const phase: "initial" | "paid" | "recover" | "refresh_quote" =
    stage === "before_initial_http"
      ? record.action === "request"
        ? "initial"
        : record.action
      : "paid";
  return { client, phase, context };
}

export function authorizeOutbound(
  store: RequestStore,
  handle: ClientHandle,
  requestId: string,
  frozen: FrozenRequest,
  stage: OutboundAuthorizationContext["stage"],
  signal: AbortSignal,
): Promise<boolean> {
  const { client, phase, context } = outboundContext(
    store,
    handle,
    requestId,
    frozen,
    stage,
    signal,
  );
  return store.env.authorize(structuredClone(frozen), client, phase, signal, context);
}

/** The trusted approval owner must answer synchronously at the actual effect boundary. */
export function checkOutbound(
  store: RequestStore,
  handle: ClientHandle,
  requestId: string,
  frozen: FrozenRequest,
  stage: OutboundAuthorizationContext["stage"],
  effect: OutboundEffect,
  signal: AbortSignal,
): void {
  const { client, context } = outboundContext(store, handle, requestId, frozen, stage, signal);
  const decision =
    typeof store.env.checkOutbound === "function"
      ? store.env.checkOutbound(client, context, effect)
      : false;
  if (decision !== true) void Promise.resolve(decision).catch(() => {});
  requireWallet(
    decision === true,
    "OUTBOUND_PERMISSION_REQUIRED",
    "The trusted outbound approval is no longer current.",
  );
  // A callback can synchronously cancel or change the wallet context.
  outboundContext(store, handle, requestId, frozen, stage, signal);
}
