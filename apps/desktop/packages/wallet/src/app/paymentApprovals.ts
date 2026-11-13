import { paymentStage } from "./paymentTiming.js";
import { randomUUID } from "node:crypto";
import { requireWallet } from "../domain/errors.js";
import { checkBudget } from "../domain/budget.js";
import { checkGrant } from "../domain/grants.js";
import type { FrozenRequest, StoredQuote } from "../domain/requestModel.js";
import type { WalletState } from "./state.js";
import type { ClientHandle } from "./sessions.js";
import type { RequestStore } from "./requestStore.js";
import type { RequestPayment } from "./requestPayment.js";
import type {
  PaymentApprovalView,
  PaymentApprovalChoice,
  PaymentApprovalDecision,
} from "./paymentApprovalTypes.js";
import { walletBudgetQuery } from "./managementView.js";
import { createGrantInState } from "./grantCreation.js";
import { byteDigest } from "./requestFacts.js";

type Approval = {
  id: string;
  handle: ClientHandle;
  requestId: string;
  walletId: string;
  epoch: string;
  frozenDigest: string;
  quoteRef: string;
  frozen: FrozenRequest;
  quote: StoredQuote;
  signal?: AbortSignal;
};
const MAX_APPROVALS = 32;
const choices = new Set<string>(["deny", "once", "session", "persistent", "continue"]);

/** Utility-local capabilities for the trusted UI. Policy remains in protected wallet state. */
export class WalletPaymentApprovals {
  private readonly entries = new Map<string, Approval>();
  private closed = false;
  constructor(
    private readonly store: RequestStore,
    private readonly payment: RequestPayment,
    private readonly cancel: (handle: ClientHandle, id: string) => Promise<unknown>,
  ) {}

  async prepare(
    handle: ClientHandle,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<PaymentApprovalView> {
    this.assertLive(signal);
    this.prune();
    const record = this.store.owned(handle, requestId);
    const frozen = await this.store.frozen(record),
      quote = await this.store.quote(record);
    this.assertLive(signal);
    const prepared = this.payment.scope(handle, record, frozen, quote);
    const entry: Approval = {
      id: randomUUID(),
      handle,
      requestId,
      walletId: prepared.walletId,
      epoch: record.epoch,
      frozenDigest: record.frozenDigest,
      quoteRef: record.quoteRef!,
      frozen,
      quote,
      signal,
    };
    this.assertContext(entry, this.store.ctx.state.snapshot(), signal);
    for (const [id, old] of this.entries)
      if (old.handle === handle && old.requestId === requestId) this.entries.delete(id);
    requireWallet(
      this.entries.size < MAX_APPROVALS,
      "WALLET_BUSY",
      "The payment approval capacity is exhausted.",
    );
    const bytes = frozen.body === null ? null : Buffer.from(frozen.body);
    try {
      const state = this.store.ctx.state.snapshot(),
        target = new URL(frozen.url);
      const result: PaymentApprovalView = {
        ...walletBudgetQuery(
          this.store.ctx,
          state,
          state.wallets.find((w) => w.walletId === prepared.walletId)!,
        ),
        approvalId: entry.id,
        requestId,
        operationId: record.operationId,
        origin: target.origin,
        path: target.pathname,
        method: frozen.method,
        payTo: prepared.scope.payTo,
        amountAtomic: prepared.scope.amountAtomic,
        paymentScheme: quote.selected.scheme,
        network: prepared.scope.network,
        asset: prepared.scope.asset,
        maxTimeoutSeconds: quote.selected.maxTimeoutSeconds + (quote.selected.scheme === "upto" ? 120 : 0),
        bodyByteLength: frozen.hostPayment?.bodyByteLength ?? bytes?.byteLength ?? 0,
        bodySha256: frozen.hostPayment ? frozen.hostPayment.bodySha256 : bytes ? byteDigest(bytes) : null,
        expiresInMs: Math.max(
          0,
          Math.floor(
            Math.min(
              60000 - (this.store.env.wall() - quote.receivedAt),
              60000 - (this.store.env.monotonic() - quote.receivedMonotonic),
            ),
          ),
        ),
        diagnosticCode: record.diagnosticCode ?? null,
      };
      this.entries.set(entry.id, entry);
      return result;
    } finally {
      bytes?.fill(0);
    }
  }

  async decide(
    handle: ClientHandle,
    approvalId: string,
    choice: PaymentApprovalChoice,
    signal?: AbortSignal,
  ): Promise<PaymentApprovalDecision> {
    requireWallet(choices.has(choice), "INVALID_REQUEST", "The trusted payment choice is invalid.");
    const entry = this.entries.get(approvalId);
    requireWallet(
      entry && entry.handle === handle,
      "PAYMENT_APPROVAL_REQUIRED",
      "The payment approval is unavailable.",
    );
    const { ctx } = this.store;
    const current = () => {
      requireWallet(
        this.entries.get(approvalId) === entry,
        "PAYMENT_APPROVAL_REQUIRED",
        "The payment approval was already consumed.",
      );
      if (choice === "deny") {
        this.assertLive(signal);
        this.store.owned(handle, entry.requestId);
      } else this.assertContext(entry, ctx.state.snapshot(), signal);
    };
    current();
    return paymentStage(entry.requestId, "approval_decision", () => ctx.controls.run(async () => {
      current();
      if (choice === "deny") {
        this.entries.delete(approvalId);
        await this.cancel(handle, entry.requestId);
        return { requestId: entry.requestId, denied: true };
      }
      const state = ctx.state.snapshot(),
        wallet = state.wallets.find((w) => w.walletId === entry.walletId)!;
      const combined = AbortSignal.any([
        ctx.fence.signal,
        ...(signal ? [signal] : []),
        ...(entry.signal ? [entry.signal] : []),
      ]);
      const record = this.store.owned(handle, entry.requestId);
      if (record.modelPayment) await this.payment.preparationTime(handle, record, combined);
      else {
        const chain = await ctx.chain.snapshot(wallet.network, wallet.address, combined);
        ctx.clock.update(chain.latest.timestamp, ctx.state.snapshot().trustedTime);
      }
      current();
      return ctx.state.mutate((next) => {
        current();
        this.assertContext(entry, next, signal);
        const record = next.transport!.requests.find((r) => r.requestId === entry.requestId)!;
        const scope = this.payment.scope(handle, record, entry.frozen, entry.quote).scope;
        const context = ctx.sessions.requireSubject(handle, scope.subjectId, next),
          now = ctx.clock.now();
        checkBudget(
          next.subjects.find((s) => s.subjectId === scope.subjectId)!,
          next.policies[scope.subjectId]!,
          next.events,
          scope.amountAtomic,
          now,
        );
        let grantId: string | undefined;
        if (choice === "continue") {
          requireWallet(
            next.grants.some((grant) => {
              try {
                checkGrant(grant, scope, context, next.managementEpoch, now, ctx.sessions.hostGrantScope(handle));
                return true;
              } catch {
                return false;
              }
            }),
            "PAYMENT_APPROVAL_REQUIRED",
            "A matching live payment rule is required to continue.",
          );
        } else {
          grantId = createGrantInState(
            ctx,
            next,
            {
              walletId: entry.walletId,
              clientIds: [context.clientId],
              scope: choice,
              connection: choice === "session" ? handle : undefined,
              purchase:
                choice === "once"
                  ? {
                      requestId: record.requestId,
                      requestDigest: record.frozenDigest,
                      quoteDigest: entry.quote.digest,
                    }
                  : undefined,
              origin: scope.origin,
              path: scope.path,
              pathPrefix: false,
              method: scope.method,
              payTo: scope.payTo,
              maxAmountAtomic: choice === "session"
                ? next.policies[scope.subjectId]!.maxPerPaymentAtomic : scope.amountAtomic,
              expiresAt:
                choice === "once"
                  ? now + Math.min(120, entry.quote.selected.maxTimeoutSeconds)
                  : null,
            },
            now,
            choice === "session" && entry.frozen.hostPayment?.paymentOnly === true
              ? scope.credentialVersion ?? undefined : undefined,
          );
        }
        this.entries.delete(approvalId);
        return { requestId: entry.requestId, denied: false, ...(grantId ? { grantId } : {}) };
      });
    }));
  }

  close(): void {
    this.closed = true;
    this.entries.clear();
  }

  private assertLive(signal?: AbortSignal): void {
    requireWallet(
      !this.closed && !this.store.ctx.fence.signal.aborted && !signal?.aborted,
      "WALLET_OPERATION_ABORTED",
      "The payment approval operation is no longer active.",
    );
  }
  private assertContext(entry: Approval, state: WalletState, signal?: AbortSignal): void {
    this.assertLive(signal);
    this.assertLive(entry.signal);
    const record = this.store.owned(entry.handle, entry.requestId);
    this.store.assertCurrent(entry.handle, record, entry.frozen);
    this.payment.fresh(entry.quote);
    requireWallet(
      state.managementEpoch === entry.epoch &&
        record.epoch === entry.epoch &&
        state.defaultWalletId === entry.walletId &&
        record.action === "request" &&
        record.httpStatus === 402 &&
        record.frozenDigest === entry.frozenDigest &&
        record.quoteRef === entry.quoteRef &&
        entry.frozen.paymentMode === "policy" &&
        ["awaiting_authorization", "waiting_for_unlock", "failed"].includes(
          record.transportStatus,
        ) &&
        record.diagnosticCode !== "QUOTE_REFRESH_BUSINESS_RESULT" &&
        (!record.unsignedRefreshId || record.unsignedRefreshConsumed) &&
        state.intents
          .filter((i) => i.requestId === entry.requestId && i.clientId === record.clientId)
          .every((i) => i.status === "FAILED_UNSIGNED" && !i.reserved && !i.spent),
      "PAYMENT_CONTEXT_CHANGED",
      "The unsigned payment context changed after presentation.",
    );
  }
  private prune(): void {
    for (const [id, entry] of this.entries) {
      try {
        this.assertContext(entry, this.store.ctx.state.snapshot());
      } catch {
        this.entries.delete(id);
      }
    }
  }
}
