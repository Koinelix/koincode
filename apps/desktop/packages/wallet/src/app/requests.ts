import { MAX_CONCURRENT_HTTP_STAGES, RESPONSE_LIMIT } from "../domain/requestValidation.js";
import { WalletAllowance } from "./walletAllowance.js";
import { ModelPaymentAdmission } from "./modelPaymentAdmission.js";
import { ModelPaymentRecovery } from "./modelPaymentRecovery.js";
import { REQUEST_ACTION_TIMEOUT_MS } from "../domain/requestTiming.js";
import {
  beginRetention,
  discardIncomplete,
  recoverRetainedResponse,
  initializeRequestTransport,
} from "./requestRetention.js";
import { acquireResponseCapacity } from "./responseBudget.js";
import { RequestHttp } from "./requestHttp.js";
import { WalletRequestControls } from "./requestControls.js";
import { RequestScheduler } from "./requestScheduler.js";
import { prepareReplacement, consumeReplacement } from "./requestReplacement.js";
import type { RequestView, RequestRecord, FrozenRequest } from "../domain/requestModel.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import type { RuntimeContext } from "./runtimeContext.js";
import type { ProtectedStore } from "./ports.js";
import type { RequestEnvironment, RequestWork } from "./requestPorts.js";
import type { PaymentBuilder } from "./paymentBuilder.js";
import type { WalletPayments } from "./payments.js";
import type { WalletReconciliation } from "./reconciliation.js";
import type { ClientHandle } from "./sessions.js";
import { WalletConnections, WalletCredentials } from "./transportAccess.js";
import { ownedOperation } from "./transportState.js";
import { RequestStore } from "./requestStore.js";
import { view, byteDigest } from "./requestFacts.js";
import { RequestPayment } from "./requestPayment.js";
import { ResponseRetentionOwner } from "./responseRetentionOwner.js";
import { WalletJournalAnchors } from "./journalAnchors.js";
import { WalletPaymentApprovals } from "./paymentApprovals.js";
import { clientRequestWork, withClientCancellation } from "./requestWait.js";
export class WalletRequests {
  readonly allowance: WalletAllowance;
  readonly modelAdmission: ModelPaymentAdmission;
  readonly modelRecovery: ModelPaymentRecovery;
  readonly approvals: WalletPaymentApprovals;
  readonly journalAnchors: WalletJournalAnchors;
  readonly connections: WalletConnections;
  readonly credentials: WalletCredentials;
  readonly store: RequestStore;
  readonly payment: RequestPayment;
  readonly controls: WalletRequestControls;
  #scheduler: RequestScheduler;
  #http: RequestHttp;
  #running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  #preparing = 0;
  private get hasHttpSlot(): boolean {
    return this.#preparing + this.#running.size < MAX_CONCURRENT_HTTP_STAGES;
  }
  #closed = false;
  #retention?: ResponseRetentionOwner;
  #closing?: Promise<void>;
  private constructor(
    private readonly ctx: RuntimeContext,
    private readonly reconciliation: WalletReconciliation,
    env: RequestEnvironment,
    protection: ProtectedStore,
    payments: WalletPayments,
    builder: PaymentBuilder,
  ) {
    this.journalAnchors = new WalletJournalAnchors(ctx);
    this.connections = new WalletConnections(ctx);
    this.credentials = new WalletCredentials(ctx, protection);
    this.store = new RequestStore(ctx, env, this.credentials);
    this.modelAdmission = new ModelPaymentAdmission(this.store, payments);
    this.allowance = new WalletAllowance(ctx, protection, (id, ledger) => this.modelAdmission.displayHolds(id, ledger));
    this.modelRecovery = new ModelPaymentRecovery(this.store, reconciliation, this.modelAdmission);
    this.payment = new RequestPayment(this.store, payments, builder, this.modelAdmission,
      requestId => this.modelRecovery.watchSigned(requestId));
    const cancel = this.cancel.bind(this);
    this.approvals = new WalletPaymentApprovals(this.store, this.payment, cancel);
    if (env.retainedBlobs)
      this.#retention = new ResponseRetentionOwner(ctx.state, env.retainedBlobs, env.wall);
    this.#http = new RequestHttp(this.store, this.payment, reconciliation, this.#retention);
    this.controls = new WalletRequestControls(
      this.store,
      (handle, id, paid, work) => this.run(handle, id, paid, work),
      (handle, id) => this.get(handle, id),
      cancel,
    );
    this.#scheduler = new RequestScheduler(this.store, (handle, id, work) =>
      this.advance(handle, id, work),
    );
  }
  static async start(
    ctx: RuntimeContext,
    reconciliation: WalletReconciliation,
    env: RequestEnvironment,
    protection: ProtectedStore,
    payments: WalletPayments,
    builder: PaymentBuilder,
  ): Promise<WalletRequests> {
    await initializeRequestTransport(ctx, env);
    const requests = new WalletRequests(ctx, reconciliation, env, protection, payments, builder);
    if (!ctx.fence.signal.aborted) await requests.#retention?.cleanupIncomplete(1);
    requests.modelRecovery.resume();
    return requests;
  }
  async request(
    handle: ClientHandle,
    input: unknown,
    operationId: string,
    callerSignal?: AbortSignal,
  ): Promise<RequestView> {
    requireWallet(
      !this.#closed && this.hasHttpSlot,
      "HTTP_BUSY",
      "The wallet request service is closed or busy.",
    );
    this.#preparing++;
    let prepared: Awaited<ReturnType<RequestStore["prepare"]>>;
    try {
      prepared = await this.store.prepare(handle, input, operationId);
    } finally {
      this.#preparing--;
    }
    // run() takes the execution slot synchronously before its first await.
    if (prepared.created) {
      const id = prepared.record.requestId;
      await withClientCancellation(
        callerSignal,
        () => this.cancel(handle, id),
        () => this.run(handle, id, false, clientRequestWork(callerSignal)),
      );
    }
    return this.get(handle, prepared.record.requestId);
  }
  lookupOperation(handle: ClientHandle, operationId: string): RequestView | null {
    requireWallet(
      this.ctx.state.continuityValid(),
      "OPERATION_HISTORY_INCOMPLETE",
      "Operation history continuity is unavailable.",
    );
    const state = this.ctx.state.snapshot(),
      context = this.ctx.sessions.resolve(handle, state);
    const r = ownedOperation(state, context, operationId);
    return r ? this.get(handle, r.requestId) : null;
  }
  get(handle: ClientHandle, id: string): RequestView {
    const record = this.store.owned(handle, id),
      intent = this.ctx.state
        .snapshot()
        .intents.findLast((x) => x.requestId === id && x.clientId === record.clientId);
    if (intent) {
      record.paymentIntentId = intent.intentId;
      record.paymentStatus = intent.status.toLowerCase();
      record.transactionHash = intent.settlementTx;
    }
    if (this.store.env.wall() >= record.expiresAt) {
      record.bodyRef = undefined;
      record.diagnosticCode = "REQUEST_CONTEXT_UNAVAILABLE";
    }
    return view(record);
  }
  assertResponseReadable(handle: ClientHandle, id: string): RequestRecord { return this.store.assertResponseReadable(handle, id); }
  async readResponse(handle: ClientHandle, id: string): Promise<Uint8Array> {
    const record = this.assertResponseReadable(handle, id);
    const bytes = await this.store.env.blobs.get(record.responseRef!);
    try {
      this.assertResponseReadable(handle, id);
      requireWallet(bytes.byteLength <= RESPONSE_LIMIT && bytes.byteLength === record.byteLength && byteDigest(bytes) === record.sha256,
        "RESPONSE_UNAVAILABLE", "The response integrity check failed.");
      this.assertResponseReadable(handle, id);
      return bytes;
    } catch (error) {
      try { bytes.fill(0); } catch { /* Preserve the original access or integrity error. */ }
      throw error;
    }
  }
  async cancel(handle: ClientHandle, id: string): Promise<RequestView> {
    this.store.owned(handle, id);
    this.#scheduler.cancel(id);
    const all = this.ctx.state.snapshot().transport?.requests ?? [];
    for (const [activeId, job] of this.#running) {
      let current = all.find((r) => r.requestId === activeId);
      for (let depth = 0; current && depth < 33; depth++) {
        if (current.requestId === id) {
          job.controller.abort();
          break;
        }
        current = all.find((r) => r.requestId === current?.parentRequestId);
      }
    }
    await this.store.update(id, (r) => {
      r.canceled = true;
      r.transportStatus = "canceled";
      r.diagnosticCode = "REQUEST_CANCELED";
    });
    return this.get(handle, id);
  }
  async resume(...args: Parameters<WalletRequestControls["resume"]>): Promise<RequestView> {
    return this.controls.resume(...args);
  }
  async reconcile(handle: ClientHandle, id: string, signal?: AbortSignal, transactionHash?: string): Promise<RequestView> {
    requireWallet(transactionHash === undefined || (typeof transactionHash === "string" && /^0x[0-9a-f]{64}$/i.test(transactionHash)),
      "INVALID_REQUEST", "A transaction lookup hint must be a 32-byte hash.");
    const r = this.store.owned(handle, id);
    const intent = this.ctx.state
      .snapshot()
      .intents.findLast((x) => x.requestId === id && x.clientId === r.clientId);
    if (intent) {
      let settled = false;
      if (r.transactionHash || intent.settlementTx || transactionHash)
        try {
          const result = await this.reconciliation.settle(
            intent.intentId,
            (intent.settlementTx ?? transactionHash ?? r.transactionHash)!,
            signal,
          );
          settled = result.spent;
        } catch (error) {
          if (!(error instanceof WalletError) || error.code !== "RPC_EVIDENCE_INVALID") throw error;
        }
      if (!settled) await this.reconciliation.resolve(intent.intentId, signal);
    }
    return this.get(handle, id);
  }
  async advance(handle: ClientHandle, id: string, work?: RequestWork): Promise<RequestView> {
    const parent = this.store.owned(handle, id);
    work?.assertCurrent();
    await this.reconcile(handle, id, work?.signal);
    work?.assertCurrent();
    const current = this.get(handle, id);
    if (current.paymentStatus !== "expired_unsettled") return current;
    const child = await prepareReplacement(this.store, this.payment, handle, parent);
    work?.assertCurrent();
    if (!child) return this.get(handle, id);
    if (child.transportStatus === "prepared") await this.run(handle, child.requestId, false, work);
    const replacement = await consumeReplacement(
      this.store,
      this.payment,
      handle,
      id,
      child.requestId,
    );
    work?.assertCurrent();
    if (replacement) await this.run(handle, id, true, work);
    return this.get(handle, id);
  }
  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.approvals.close();
    for (const job of this.#running.values()) job.controller.abort();
    this.#closing = (async () => {
      await this.modelRecovery.close();
      await this.#scheduler.close();
      await Promise.allSettled([...this.#running.values()].map((x) => x.done));
    })();
    return this.#closing;
  }
  /** Trusted result recovery only: does not continue a purchase or send merchant HTTP. */
  async recoverRetainedResponse(
    handle: ClientHandle,
    id: string,
    external?: AbortSignal,
  ): Promise<RequestView> {
    external?.throwIfAborted();
    requireWallet(
      !this.#closed && !this.#running.has(id) && this.hasHttpSlot && this.#retention,
      "HTTP_BUSY",
      "Retained response recovery is closed or busy.",
    );
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      this.ctx.fence.signal,
      AbortSignal.timeout(120000),
      ...(external ? [external] : []),
    ]);
    const { promise: done, resolve: complete } = Promise.withResolvers<void>();
    this.#running.set(id, { controller, done });
    try {
      await recoverRetainedResponse(this.store, this.#http, this.#retention, handle, id, signal);
      return this.get(handle, id);
    } finally {
      this.#running.delete(id);
      complete();
    }
  }
  private async run(
    handle: ClientHandle,
    id: string,
    paid: boolean,
    work?: RequestWork,
  ): Promise<void> {
    requireWallet(
      !this.#closed && !this.#running.has(id) && this.hasHttpSlot,
      "HTTP_BUSY",
      "This request is already running or the queue is full.",
    );
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      this.ctx.fence.signal,
      AbortSignal.timeout(REQUEST_ACTION_TIMEOUT_MS),
      ...(work ? [work.signal] : []),
    ]);
    const { promise: done, resolve: complete } = Promise.withResolvers<void>();
    this.#running.set(id, { controller, done });
    try {
      const record = this.store.owned(handle, id),
        frozen = await this.store.frozen(record);
      work?.assertCurrent();
      this.store.assertCurrent(handle, record, frozen);
      if (paid) {
        await this.submitPaid(handle, record, frozen, signal, work);
        return;
      }
      const reservation = acquireResponseCapacity(this.store.env.blobs);
      let status: number;
      let retentionId: string | undefined;
      try {
        retentionId = await beginRetention(this.#retention, this.store, record, "initial");
        status = await this.#http.execute(
          handle,
          record,
          frozen,
          signal,
          reservation,
          undefined,
          work,
          retentionId,
        );
      } finally {
        await discardIncomplete(this.#retention, this.store, retentionId);
        reservation.release();
      }
      const current = this.store.owned(handle, id);
      if (
        status === 402 &&
        frozen.paymentMode === "policy" &&
        current.quoteRef &&
        !current.diagnosticCode &&
        !current.canceled
      )
        await this.submitPaid(handle, current, frozen, signal, work);
    } catch (error) {
      const record = this.ctx.state.snapshot().transport?.requests.find((x) => x.requestId === id);
      if (record && !record.canceled && record.diagnosticCode !== "QUOTE_REFRESH_BUSINESS_RESULT") {
        const code = error instanceof WalletError ? error.code : "HTTP_UNKNOWN";
        await this.store.update(id, (r) => {
          if (r.canceled || r.diagnosticCode === "QUOTE_REFRESH_BUSINESS_RESULT") return;
          r.diagnosticCode = code;
          if (code === "PAYMENT_APPROVAL_REQUIRED") {
            r.transportStatus = "awaiting_authorization";
            r.paymentStatus = "awaiting_authorization";
          } else if (code === "WALLET_LOCKED") {
            r.transportStatus = "waiting_for_unlock";
            r.paymentStatus = "quoted";
          } else if (r.transportStatus !== "completed")
            r.transportStatus = r.transportStatus === "running" ? "unknown" : "failed";
        });
      }
    } finally {
      this.#running.delete(id);
      complete();
    }
  }
  private async submitPaid(
    handle: ClientHandle,
    r: RequestRecord,
    frozen: FrozenRequest,
    signal: AbortSignal,
    work?: RequestWork,
  ): Promise<void> {
    const reservation = acquireResponseCapacity(this.store.env.blobs);
    let retentionId: string | undefined;
    try {
      retentionId = await beginRetention(this.#retention, this.store, r, "paid");
      const signed = await this.payment.signWithApproval(
        handle,
        r,
        frozen,
        signal,
        reservation,
        work,
      );
      const current = this.store.owned(handle, r.requestId);
      await this.#http.execute(
        handle,
        current,
        frozen,
        signal,
        reservation,
        signed.header,
        work,
        retentionId,
      );
    } finally {
      await discardIncomplete(this.#retention, this.store, retentionId);
      reservation.release();
    }
    await this.#scheduler.schedule(handle, r.requestId, work?.callerSignal);
  }
}
