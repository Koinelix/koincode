import { paymentStage } from "./paymentTiming.js";
import { requestDeadline } from "./requestDeadline.js";
import { REQUEST_PREPARATION_TIMEOUT_MS } from "../domain/requestTiming.js";
import { authorizeOutbound, checkOutbound } from "./outboundAuthorization.js";
import { abortable } from "./requestWait.js";
import type { ResponseReservation, RequestWork } from "./requestPorts.js";
import { parseQuote } from "./requestQuote.js";
import type { ClientHandle } from "./sessions.js";
import type { RequestRecord, FrozenRequest, StoredQuote } from "../domain/requestModel.js";
import type { PaymentScope } from "../domain/model.js";
import type { WalletPayments } from "./payments.js";
import type { PaymentBuilder } from "./paymentBuilder.js";
import { requireWallet, WalletError } from "../domain/errors.js";
import { RequestStore } from "./requestStore.js";
import { requestDigest } from "./requestFacts.js";
import { checkGrant } from "../domain/grants.js";
import { checkBudget } from "../domain/budget.js";
export class RequestPayment {
  readonly clockId = crypto.randomUUID();
  constructor(
    private readonly store: RequestStore,
    private readonly payments: WalletPayments,
    private readonly builder: PaymentBuilder,
    private readonly modelAdmission: {
      assert(handle: ClientHandle, operationId: string): { shared: boolean };
      reserved(handle: ClientHandle, operationId: string, intentId: string): void;
    },
    private readonly onModelSigned: (requestId: string) => void,
  ) {}
  async preparationTime(handle: ClientHandle, record: RequestRecord, signal?: AbortSignal): Promise<number> {
    const ctx = this.store.ctx;
    if (record.modelPayment) {
      this.modelAdmission.assert(handle, record.operationId);
      try { return ctx.clock.now(); }
      catch (error) { if (!(error instanceof WalletError) || error.code !== "CHAIN_TIME_STALE") throw error; }
    }
    const wallet = ctx.state.snapshot().wallets.find(item => item.walletId === ctx.state.snapshot().defaultWalletId);
    requireWallet(wallet, "WALLET_NOT_FOUND", "No default wallet is available.");
    const snapshot = await ctx.chain.snapshot(wallet.network, wallet.address, signal);
    if (record.modelPayment) this.modelAdmission.assert(handle, record.operationId);
    return ctx.clock.update(snapshot.latest.timestamp, ctx.state.snapshot().trustedTime);
  }
  /** Payment-only clients own their business HTTP. Wallet approval never grants merchant network access. */
  async signPaymentOnly(handle: ClientHandle, r: RequestRecord, frozen: FrozenRequest,
    signal: AbortSignal, reservation: ResponseReservation, expectedWalletId?: string, expectedQuoteDigest?: string): Promise<{ intentId: string; header: string }> {
    requireWallet(frozen.hostPayment?.paymentOnly === true && frozen.body === null && frozen.credentialRef === null &&
      frozen.businessKey === null && Object.keys(frozen.headers).length === 0,
    "PAYMENT_CONTEXT_CHANGED", "A payment-only operation cannot contain merchant execution state.");
    const preparation = requestDeadline(signal, REQUEST_PREPARATION_TIMEOUT_MS, this.store.env);
    try {
      preparation.check();
      this.assertExpectedWallet(expectedWalletId);
      this.store.assertCurrent(handle, r, frozen);
      if (r.modelPayment) this.modelAdmission.assert(handle, r.operationId);
      const signed = await this.sign(handle, r, frozen, preparation.signal, reservation, () => {
        preparation.check();
        this.assertExpectedWallet(expectedWalletId);
        this.store.assertCurrent(handle, r, frozen);
        if (r.modelPayment) this.modelAdmission.assert(handle, r.operationId);
      }, expectedQuoteDigest);
      preparation.check();
      return signed;
    } finally { preparation.close(); }
  }
  async signWithApproval(handle: ClientHandle, r: RequestRecord, frozen: FrozenRequest,
    signal: AbortSignal, reservation: ResponseReservation, work?: RequestWork,
    expectedWalletId?: string): Promise<{ intentId: string; header: string }> {
    const preparation = requestDeadline(signal, REQUEST_PREPARATION_TIMEOUT_MS, this.store.env);
    try {
      requireWallet(
        (await abortable(
          authorizeOutbound(this.store, handle, r.requestId, frozen, "before_sign", preparation.signal),
          preparation.signal,
        )) === true,
        "OUTBOUND_PERMISSION_REQUIRED",
        "The trusted host did not authorize the paid action.",
      );
      preparation.check(); work?.assertCurrent();
      this.assertExpectedWallet(expectedWalletId);
      const signed = await this.sign(handle, r, frozen, preparation.signal, reservation, () => {
        preparation.check();
        work?.assertCurrent();
        this.assertExpectedWallet(expectedWalletId);
        checkOutbound(this.store, handle, r.requestId, frozen, "before_sign", "sign", preparation.signal);
        work?.assertCurrent();
        preparation.check();
      });
      preparation.check();
      return signed;
    } finally { preparation.close(); }
  }
  private assertExpectedWallet(walletId?: string): void {
    requireWallet(walletId === undefined || this.store.ctx.state.snapshot().defaultWalletId === walletId,
      "PAYMENT_CONTEXT_CHANGED", "The payment wallet differs from the wallet shown for approval.");
  }
  private assertQuote(
    handle: ClientHandle,
    r: RequestRecord,
    frozen: FrozenRequest,
    ref: string | undefined,
  ): void {
    this.store.assertCurrent(handle, r, frozen);
    const latest = this.store.owned(handle, r.requestId);
    requireWallet(
      latest.httpStatus === 402 &&
        latest.quoteRef === ref &&
        latest.diagnosticCode !== "QUOTE_REFRESH_BUSINESS_RESULT" &&
        (!latest.unsignedRefreshId || latest.unsignedRefreshConsumed),
      "PAYMENT_CONTEXT_CHANGED",
      "The current purchase quote or business outcome changed before signing.",
    );
  }
  fresh(q: StoredQuote): void {
    requireWallet(
      q.clockId === this.clockId &&
        this.store.env.wall() - q.receivedAt >= 0 &&
        this.store.env.wall() - q.receivedAt < 60000 &&
        this.store.env.monotonic() - q.receivedMonotonic >= 0 &&
        this.store.env.monotonic() - q.receivedMonotonic < 60000,
      "QUOTE_EXPIRED",
      "The actual received quote is no longer fresh.",
    );
  }
  scope(
    handle: ClientHandle,
    r: RequestRecord,
    frozen: FrozenRequest,
    q: StoredQuote,
  ): { scope: PaymentScope; address: string; walletId: string } {
    const { ctx } = this.store,
      state = ctx.state.snapshot();
    ctx.sessions.resolve(handle, state);
    const wallet = state.wallets.find(
      (x) =>
        x.walletId === state.defaultWalletId &&
        x.network === q.selected.network &&
        x.asset.toLowerCase() === q.selected.asset.toLowerCase(),
    );
    requireWallet(wallet, "WALLET_NOT_FOUND", "No compatible default wallet is configured.");
    ctx.sessions.requireSubject(handle, wallet.subjectId, state);
    const url = new URL(frozen.url),
      scope: PaymentScope = {
        scheme: q.selected.scheme,
        subjectId: wallet.subjectId,
        requestId: r.requestId,
        requestDigest: r.frozenDigest,
        quoteDigest: q.digest,
        credentialVersion: frozen.hostPayment?.paymentOnly === true
          ? `host:${frozen.hostPayment.credentialTag ?? "none"}`
          : frozen.credentialVersion === null ? null : String(frozen.credentialVersion),
        origin: url.origin,
        path: url.pathname,
        method: frozen.method,
        network: q.selected.network,
        asset: q.selected.asset.toLowerCase(),
        payTo: q.selected.payTo.toLowerCase(),
        amountAtomic: q.selected.amount,
      };

    return { scope, address: wallet.address, walletId: wallet.walletId };
  }
  select(
    handle: ClientHandle,
    r: RequestRecord,
    frozen: FrozenRequest,
    quote: StoredQuote,
    onceOriginal?: StoredQuote,
  ): StoredQuote {
    return parseQuote(
      Buffer.from(JSON.stringify(quote.challenge)).toString("base64"),
      frozen.url,
      quote.receivedAt,
      quote.receivedMonotonic,
      quote.clockId,
      (candidate) => {
        if (onceOriginal)
          return requestDigest(candidate.selected) === requestDigest(onceOriginal.selected);
        try {
          const state = this.store.ctx.state.snapshot(),
            context = this.store.ctx.sessions.resolve(handle, state),
            scope = this.scope(handle, r, frozen, candidate).scope,
            now = this.store.ctx.clock.now();
          checkBudget(
            state.subjects.find((s) => s.subjectId === scope.subjectId)!,
            state.policies[scope.subjectId]!,
            state.events,
            scope.amountAtomic,
            now,
          );
          return state.grants.some((grant) => {
            try {
              checkGrant(grant, scope, context, state.managementEpoch, now, this.store.ctx.sessions.hostGrantScope(handle));
              return true;
            } catch {
              return false;
            }
          });
        } catch {
          return false;
        }
      },
      this.store.ctx.paymentNetwork,
    );
  }
  async sign(
    handle: ClientHandle,
    r: RequestRecord,
    frozen: FrozenRequest,
    signal: AbortSignal,
    reservation: ResponseReservation,
    assertWork?: () => void,
    expectedQuoteDigest?: string,
  ): Promise<{ intentId: string; header: string }> {
    requireWallet(
      frozen.paymentMode === "policy" && r.action === "request",
      "PAYMENT_MODE_NEVER",
      "This request cannot enter payment.",
    );
    let expectedQuoteRef = r.quoteRef;
    let q = await this.store.quote(r);
    this.assertQuote(handle, r, frozen, expectedQuoteRef);
    this.fresh(q);
    const ctx = this.store.ctx;
    await this.preparationTime(handle, r, signal);
    this.assertQuote(handle, r, frozen, expectedQuoteRef);
    if (!r.replacementFrom) {
      const selected = expectedQuoteDigest === undefined ? this.select(handle, r, frozen, q) : q;
      requireWallet(expectedQuoteDigest === undefined || selected.digest === expectedQuoteDigest,
        "PAYMENT_CONTEXT_CHANGED", "The quote selected for signing differs from the displayed quote.");
      if (selected.digest !== q.digest) {
        const quoteRef = await this.store.putJson(selected, reservation);
        await this.store.update(r.requestId, (record) => {
          this.assertQuote(handle, r, frozen, expectedQuoteRef);
          record.quoteRef = quoteRef;
          record.amountAtomic = selected.selected.amount;
          record.network = selected.selected.network;
        });
        expectedQuoteRef = quoteRef;
        q = selected;
      }
    }

    requireWallet(expectedQuoteDigest === undefined || q.digest === expectedQuoteDigest,
      "PAYMENT_CONTEXT_CHANGED", "The quote selected for signing differs from the displayed quote.");

    const prepared = this.scope(handle, r, frozen, q),
      state = ctx.state.snapshot(),
      context = ctx.sessions.resolve(handle, state),
      now = ctx.clock.now();
    checkBudget(
      state.subjects.find((x) => x.subjectId === prepared.scope.subjectId)!,
      state.policies[prepared.scope.subjectId]!,
      state.events,
      prepared.scope.amountAtomic,
      now,
    );
    if (!r.replacementFrom)
      requireWallet(
        state.grants.some((g) => {
          try {
            checkGrant(g, prepared.scope, context, state.managementEpoch, now, ctx.sessions.hostGrantScope(handle));
            return true;
          } catch {
            return false;
          }
        }),
        "PAYMENT_APPROVAL_REQUIRED",
        "A trusted purchase grant is required.",
      );
    requireWallet(
      ctx.unlocks.isUnlocked(prepared.walletId),
      "WALLET_LOCKED",
      "The wallet must be unlocked through trusted controls.",
    );
    const assertCurrent = () => {
      assertWork?.();
      requireWallet(!signal.aborted, "WALLET_OPERATION_ABORTED", "The request was canceled.");
      this.assertQuote(handle, r, frozen, expectedQuoteRef);
      this.fresh(q);
    };
    assertCurrent();
    const signed = await paymentStage(r.requestId, "sign", () => this.builder.build({
      handle,
      walletAddress: prepared.address,
      scope: prepared.scope,
      quote: q,
      signal,
      assertCurrent,
      ...(r.replacementFrom ? { replacementFrom: r.replacementFrom } : {}),
      ...(r.unsignedRetryFrom ? { unsignedRetryFrom: r.unsignedRetryFrom } : {}),
      ...(r.modelPayment ? { uptoShared: this.modelAdmission.assert(handle, r.operationId).shared === true,
        onReserved: (intentId: string) => this.modelAdmission.reserved(handle, r.operationId, intentId) } : {}),
    }));
    await paymentStage(r.requestId, "request_commit", async () => {
    const payloadRef = await this.store.putJson({ header: signed.header }, reservation);
    await this.store.update(r.requestId, (record) => {
      record.paymentIntentId = signed.intentId;
      if (!record.intentIds.includes(signed.intentId)) record.intentIds.push(signed.intentId);
      record.paymentStatus = "signed";
      record.payloadRef = payloadRef;
      record.signedQuoteRef = record.quoteRef;
    });
    if (r.modelPayment) this.onModelSigned(r.requestId);
    assertCurrent();
    await this.payments.submitted(signed.intentId);
    await this.store.update(r.requestId, (record) => {
      record.paymentStatus = "submitted";
      record.transportStatus = "running";
    });
    assertCurrent();
    });
    return signed;
  }
  validateReplacement(old: StoredQuote, next: StoredQuote, once: boolean): void {
    requireWallet(
      !once || requestDigest(old.selected) === requestDigest(next.selected),
      "PAYMENT_APPROVAL_REQUIRED",
      "The new quote changes the approved commercial or signing terms.",
    );
  }
}
