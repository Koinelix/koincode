import type { RequestStore } from "./requestStore.js";
import type { ClientHandle } from "./sessions.js";
import type { RequestRecord, RequestView } from "../domain/requestModel.js";
import { requireWallet } from "../domain/errors.js";
import { registerUnsignedRefresh, consumeUnsignedRefresh } from "./unsignedRefreshState.js";
import { requestControlMutation } from "./requestControlMutation.js";
import { clientRequestWork, withClientCancellation } from "./requestWait.js";
import type { RequestWork } from "./requestPorts.js";
// Trusted host actions. These are deliberately absent from MCP tools and the client SDK.
export class WalletRequestControls {
  constructor(
    private readonly store: RequestStore,
    private readonly execute: (
      handle: ClientHandle,
      id: string,
      paid: boolean,
      work?: RequestWork,
    ) => Promise<void>,
    private readonly get: (handle: ClientHandle, id: string) => RequestView,
    private readonly cancel: (handle: ClientHandle, id: string) => Promise<RequestView>,
  ) {}
  async resume(
    handle: ClientHandle,
    id: string,
    signal?: AbortSignal,
    expectedWalletId?: string,
  ): Promise<RequestView> {
    const work = clientRequestWork(
      signal,
      expectedWalletId === undefined
        ? undefined
        : () => {
            requireWallet(
              this.store.ctx.state.snapshot().defaultWalletId === expectedWalletId,
              "PAYMENT_CONTEXT_CHANGED",
              "The displayed payment wallet changed before continuation.",
            );
          },
    );
    await withClientCancellation(
      signal,
      () => this.cancel(handle, id),
      async () => {
        await this.continue(handle, id, false, undefined, signal, expectedWalletId);
        await this.execute(handle, id, true, work);
      },
    );
    return this.get(handle, id);
  }

  async continue(
    handle: ClientHandle,
    id: string,
    refresh = false,
    operationId?: string,
    signal?: AbortSignal,
    expectedWalletId?: string,
  ): Promise<RequestRecord> {
    const frozen = await this.store.frozen(this.store.owned(handle, id));
    return requestControlMutation(this.store, (state, beginChange) => {
      requireWallet(
        expectedWalletId === undefined || state.defaultWalletId === expectedWalletId,
        "PAYMENT_CONTEXT_CHANGED",
        "The displayed payment wallet changed before continuation.",
      );
      requireWallet(
        !signal?.aborted,
        "WALLET_OPERATION_ABORTED",
        "The request continuation was canceled.",
      );
      const context = this.store.ctx.sessions.resolve(handle, state),
        parent = state.transport!.requests.find((r) => r.requestId === id)!,
        intents = state.intents.filter(
          (i) => i.requestId === id && i.clientId === context.clientId,
        );
      const consumed = state.transport!.requests.find(
        (r) =>
          r.ownerId === context.ownerId &&
          r.clientId === context.clientId &&
          r.operationId === operationId &&
          r.parentRequestId === id &&
          r.unsignedRefreshConsumedBy === id,
      );
      if (refresh && consumed) return parent;
      requireWallet(
        parent.ownerId === context.ownerId &&
          parent.clientId === context.clientId &&
          parent.epoch === state.managementEpoch &&
          !parent.canceled &&
          parent.action === "request" &&
          parent.httpStatus === 402 &&
          frozen.paymentMode === "policy" &&
          !["running", "unknown", "canceled"].includes(parent.transportStatus) &&
          parent.diagnosticCode !== "QUOTE_REFRESH_BUSINESS_RESULT" &&
          (!parent.unsignedRefreshId ||
            parent.unsignedRefreshConsumed ||
            (refresh &&
              state.transport!.requests.find((r) => r.requestId === parent.unsignedRefreshId)
                ?.operationId === operationId)) &&
          intents.every((i) => i.status === "FAILED_UNSIGNED" && !i.reserved && !i.spent),
        "REQUEST_NOT_RESUMABLE",
        "A possibly signed or unknown purchase cannot be resumed as unsigned.",
      );
      beginChange();
      const changed =
        (parent.executionSessionId ?? parent.sessionId) !== context.sessionId ||
        (parent.executionGeneration ?? parent.generation) !== context.generation;
      if (changed || refresh)
        for (const grant of state.grants)
          if (grant.scope === "once" && grant.requestId === id && grant.status === "active") {
            grant.status = "revoked";
            grant.version++;
          }
      parent.executionSessionId = context.sessionId;
      parent.executionGeneration = context.generation;
      if (intents.length) parent.unsignedRetryFrom = intents.at(-1)!.intentId;
      return parent;
    });
  }
  async refreshUnsigned(
    handle: ClientHandle,
    id: string,
    operationId: string,
  ): Promise<RequestView> {
    const parent = await this.continue(handle, id, true, operationId),
      prepared = await this.store.prepare(
        handle,
        {
          requestContextRef: id,
          requestContextAction: "refresh_quote",
          paymentMode: "never",
        },
        operationId,
      ),
      frozen = await this.store.frozen(parent),
      previous = { ref: parent.quoteRef, quote: await this.store.quote(parent) },
      action = await registerUnsignedRefresh(
        this.store,
        handle,
        id,
        prepared.record.requestId,
        frozen,
        previous,
      );
    if (action === "observe") return this.get(handle, id);
    if (action === "execute") await this.execute(handle, prepared.record.requestId, false);
    const child = this.store.owned(handle, prepared.record.requestId);
    if (child.transportStatus !== "completed") return this.get(handle, id);
    const quote =
        child.httpStatus === 402 && child.quoteRef ? await this.store.quote(child) : undefined,
      consumed = await consumeUnsignedRefresh(this.store, handle, id, child, frozen, quote);
    if (consumed === "quote") await this.execute(handle, id, true);
    return this.get(handle, id);
  }
}
