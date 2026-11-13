import type { FrozenRequest, RequestRecord, StoredQuote } from "../domain/requestModel.js";
import type { WalletState } from "./state.js";
import type { RequestStore } from "./requestStore.js";
import type { ClientHandle } from "./sessions.js";
import { requireWallet } from "../domain/errors.js";
import { requestDigest } from "./requestFacts.js";
import { requestControlMutation } from "./requestControlMutation.js";
export type RefreshAction = "observe" | "execute" | "consume" | "quote" | "business";
function pair(
  store: RequestStore,
  state: WalletState,
  handle: ClientHandle,
  id: string,
  childId: string,
) {
  const context = store.ctx.sessions.resolve(handle, state),
    parent = state.transport!.requests.find((r) => r.requestId === id),
    child = state.transport!.requests.find((r) => r.requestId === childId);
  requireWallet(
    parent &&
      child &&
      parent.ownerId === context.ownerId &&
      parent.clientId === context.clientId &&
      child.ownerId === context.ownerId &&
      child.clientId === context.clientId &&
      child.parentRequestId === id &&
      child.action === "refresh_quote" &&
      parent.epoch === state.managementEpoch &&
      child.epoch === state.managementEpoch,
    "REQUEST_CONFLICT",
    "The unsigned refresh identity is unavailable or belongs to another purchase.",
  );
  return { parent, child };
}
function unsigned(
  store: RequestStore,
  state: WalletState,
  handle: ClientHandle,
  parent: RequestRecord,
  child: RequestRecord,
  frozen: FrozenRequest,
) {
  requireWallet(
    !parent.canceled &&
      parent.action === "request" &&
      parent.httpStatus === 402 &&
      frozen.paymentMode === "policy" &&
      parent.frozenDigest === requestDigest(frozen) &&
      child.frozenDigest === requestDigest({ ...frozen, paymentMode: "never" }) &&
      parent.diagnosticCode !== "QUOTE_REFRESH_BUSINESS_RESULT" &&
      !state.intents.some(
        (i) =>
          i.requestId === parent.requestId &&
          (i.status !== "FAILED_UNSIGNED" || i.reserved || i.spent),
      ),
    "REQUEST_NOT_RESUMABLE",
    "The unsigned refresh cannot change a possibly signed or completed purchase.",
  );
  store.assertCurrent(handle, parent, frozen);
  store.assertCurrent(handle, child, { ...frozen, paymentMode: "never" });
}
// Each reducer re-reads both tombstone and pending pointer after all asynchronous preparation.
export function registerUnsignedRefresh(
  store: RequestStore,
  handle: ClientHandle,
  id: string,
  childId: string,
  frozen: FrozenRequest,
  previous: { ref: string | undefined; quote: StoredQuote },
): Promise<RefreshAction> {
  return requestControlMutation(store, (state, beginChange) => {
    const { parent, child } = pair(store, state, handle, id, childId);
    if (child.unsignedRefreshConsumedBy === id) return "observe";
    requireWallet(
      !child.unsignedRefreshConsumedBy,
      "REQUEST_CONFLICT",
      "The refresh tombstone has another owner.",
    );
    unsigned(store, state, handle, parent, child, frozen);
    requireWallet(
      !parent.unsignedRefreshId ||
        parent.unsignedRefreshId === childId ||
        (parent.unsignedRefreshConsumed &&
          parent.quoteRef === previous.ref &&
          store.env.wall() - previous.quote.receivedAt >= 60000),
      "QUOTE_REFRESH_REQUIRED",
      "Another unsigned refresh is pending or its current quote remains fresh.",
    );
    if (
      parent.unsignedRefreshId === childId &&
      child.transportStatus !== "prepared" &&
      child.transportStatus !== "completed"
    )
      return "observe";
    beginChange();
    parent.unsignedRefreshId = childId;
    parent.unsignedRefreshConsumed = false;
    parent.relatedRequestId = childId;
    parent.diagnosticCode = "QUOTE_REFRESH_PENDING";
    return child.transportStatus === "prepared"
      ? "execute"
      : child.transportStatus === "completed"
        ? "consume"
        : "observe";
  });
}
export function consumeUnsignedRefresh(
  store: RequestStore,
  handle: ClientHandle,
  id: string,
  observed: RequestRecord,
  frozen: FrozenRequest,
  quote?: StoredQuote,
): Promise<RefreshAction> {
  return requestControlMutation(store, (state, beginChange) => {
    const { parent, child } = pair(store, state, handle, id, observed.requestId);
    if (child.unsignedRefreshConsumedBy === id) return "observe";
    unsigned(store, state, handle, parent, child, frozen);
    requireWallet(
      parent.unsignedRefreshId === child.requestId &&
        !parent.unsignedRefreshConsumed &&
        child.transportStatus === "completed" &&
        child.httpStatus === observed.httpStatus &&
        child.quoteRef === observed.quoteRef &&
        !child.unsignedRefreshConsumedBy,
      "QUOTE_REFRESH_REQUIRED",
      "The unsigned refresh is incomplete, changed or already consumed.",
    );
    if (child.httpStatus === 402)
      requireWallet(
        quote && child.quoteRef && !child.diagnosticCode,
        "X402_INVALID_CHALLENGE",
        "The unsigned refresh did not return a valid payment challenge.",
      );
    beginChange();
    child.unsignedRefreshConsumedBy = id;
    parent.unsignedRefreshConsumed = true;
    if (child.httpStatus !== 402) {
      parent.relatedRequestId = child.requestId;
      parent.transportStatus = "completed";
      parent.diagnosticCode = "QUOTE_REFRESH_BUSINESS_RESULT";
      return "business";
    }
    parent.quoteRef = child.quoteRef;
    parent.amountAtomic = quote!.selected.amount;
    parent.network = quote!.selected.network;
    parent.transportStatus = "awaiting_authorization";
    delete parent.diagnosticCode;
    return "quote";
  });
}
