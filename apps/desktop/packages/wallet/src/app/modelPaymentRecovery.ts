import type { ModelPaymentAdmission } from "./modelPaymentAdmission.js";
import type { RequestStore } from "./requestStore.js";
import { confirmable, type WalletReconciliation } from "./reconciliation.js";
import { requireWallet, WalletError } from "../domain/errors.js";
import { transport } from "./transportState.js";
import type { RequestRecord } from "../domain/requestModel.js";

/** Wallet owns protected recovery facts. Recovery never needs a live Agent or grants a new signature. */
export class ModelPaymentRecovery {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly pending = new Set<string>();
  // Safe follow-ups only read the chain, so they use a separate pool and never starve platform recovery.
  private readonly following = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly followPending = new Set<string>();
  // Follow-ups that saw changed evidence or an orphaned transaction hand the record to full recovery once.
  private readonly fullRecovery = new Set<string>();
  // Expired payments the platform does not know and the chain cannot yet prove unused. They leave automatic
  // recovery until the user asks for it; a used nonce without local settlement evidence needs a person.
  private readonly stalled = new Set<string>();
  // One pending chain re-check per payment unknown to the platform; readiness triggers are rare in a session.
  private readonly rechecks = new Map<string, AbortController>();
  private closed = false;
  constructor(private readonly store: RequestStore, private readonly reconciliation: WalletReconciliation,
    private readonly admission: ModelPaymentAdmission) {}

  /** If the host closes after receiving a signature, the wallet still owns its original recovery. */
  watchSigned(id: string): void { this.recheck(id, 60000); }

  resume(): void {
    if (this.closed) return;
    for (const record of transport(this.store.ctx.state.snapshot()).requests) {
      if (record.modelPayment && record.payloadRef && record.paymentIntentId && !this.terminal(record) &&
        !this.stalled.has(record.requestId)) this.queue(record);
    }
    this.pump();
  }
  async request(id: string): Promise<void> {
    const record = transport(this.store.ctx.state.snapshot()).requests.find(item => item.requestId === id);
    requireWallet(record?.modelPayment, "REQUEST_NOT_FOUND", "The original model payment is unavailable.");
    await this.store.update(id, value => { value.recoveryRequested = true; });
    this.stalled.delete(id);
    if (!this.closed && record.payloadRef && record.paymentIntentId && !this.terminal(record)) {
      this.queue(record);
      this.pump();
    }
  }
  private terminal(record: RequestRecord): boolean {
    const intent = this.store.ctx.state.snapshot().intents.find(item => item.intentId === record.paymentIntentId);
    return !!intent && ["CONFIRMED", "EXPIRED_UNSETTLED", "CANCELED_UNSETTLED", "FAILED_UNSIGNED"].includes(intent.status);
  }
  private queue(record: RequestRecord): void {
    if (this.observed(record) && !this.fullRecovery.has(record.requestId)) this.followPending.add(record.requestId);
    else this.pending.add(record.requestId);
  }
  private observed(record: RequestRecord): boolean {
    const intent = this.store.ctx.state.snapshot().intents.find(item => item.intentId === record.paymentIntentId);
    return !!intent && confirmable(intent);
  }
  private pump(): void {
    if (this.closed) return;
    for (const id of this.followPending) {
      if (this.following.size >= 8) break;
      this.followPending.delete(id);
      if (this.following.has(id)) continue;
      const controller = new AbortController();
      const done = this.followUp(id, controller.signal).catch(() => {
        // The record stays observed and reserved; a later readiness trigger follows it again.
      }).finally(() => { this.following.delete(id); this.pump(); });
      this.following.set(id, { controller, done });
    }
    for (const id of this.pending) {
      if (this.active.size >= 4) break;
      if (this.following.has(id)) continue; // Stays queued; picked up once the follow-up ends.
      this.pending.delete(id);
      if (this.active.has(id)) continue;
      const controller = new AbortController();
      const done = this.run(id, controller.signal).catch(() => {
        // Missing protected material or evidence remains pending until an explicit readiness trigger.
      }).finally(() => { this.active.delete(id); this.fullRecovery.delete(id); this.pump(); });
      this.active.set(id, { controller, done });
    }
  }
  private async run(id: string, signal: AbortSignal): Promise<void> {
    for (const delay of [0, 2000, 4000, 8000, 16000, 30000]) {
      if (signal.aborted) return;
      if (delay) await this.store.env.delay(delay, signal);
      const record = transport(this.store.ctx.state.snapshot()).requests.find(item => item.requestId === id);
      if (!record || this.terminal(record) || this.stalled.has(id)) return;
      if (this.observed(record) && !this.fullRecovery.has(id)) {
        // Bill and settlement are recorded; only safe remains, which needs no platform call or lease.
        this.followPending.add(id);
        return;
      }
      let chainChecked = false;
      try {
        chainChecked = await this.attempt(record, AbortSignal.any([signal, AbortSignal.timeout(120000)]));
      } catch {
        // Neither a timeout nor a 404 proves that a possible authorization is unused.
      }
      // An expired payment unknown to the platform was resolved on chain once; the next trigger checks again.
      if (chainChecked) return;
    }
    const record = transport(this.store.ctx.state.snapshot()).requests.find(item => item.requestId === id);
    if (signal.aborted || !record || this.terminal(record) || !this.store.ctx.state.continuityValid()) return;
    if (this.observed(record)) {
      if (!this.fullRecovery.has(id)) this.followPending.add(id);
      return;
    }
    // Malformed or persistently pending bills also leave an outstanding signature. Keep a bounded
    // proof check scheduled independently of the short series of bill lookups.
    await this.checkUnusedAuthorization(record, AbortSignal.any([signal, AbortSignal.timeout(120000)]), true);
  }
  /** Returns true after a possibly unused, expired authorization went to the chain. */
  private async attempt(record: RequestRecord, signal: AbortSignal): Promise<boolean> {
    requireWallet(this.store.ctx.state.continuityValid() && record.modelPayment && record.payloadRef && record.paymentIntentId,
      "OPERATION_HISTORY_INCOMPLETE", "Protected model recovery material is unavailable.");
    const frozen = await this.store.frozen(record), recovery = frozen.hostPayment?.modelRecovery;
    requireWallet(recovery && frozen.hostPayment?.paymentOnly && frozen.hostPayment.credentialTag === null,
      "PAYMENT_CONTEXT_CHANGED", "The anonymous recovery binding is missing.");
    const bytes = await this.store.env.blobs.get(record.payloadRef);
    let header: string;
    try {
      const material = JSON.parse(Buffer.from(bytes).toString("utf8"));
      requireWallet(typeof material.header === "string" && material.header.length <= 65536,
        "PAYMENT_CONTEXT_CHANGED", "The protected payment payload is invalid.");
      header = material.header;
    } finally { bytes.fill(0); }
    const request = { ...frozen, httpTimeoutMs: 15000, body: null,
      headers: { "idempotency-key": recovery.idempotencyKey, "x-koinelix-recover-only": "true",
        ...(recovery.contentType ? { "content-type": recovery.contentType } : {}) } };
    const lookup = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const result = await this.store.env.http.send(request, { "payment-signature": header }, lookup,
      () => !this.closed && !signal.aborted && this.store.ctx.state.continuityValid()).catch(() => undefined);
    signal.throwIfAborted();
    if (this.closed || !this.store.ctx.state.continuityValid()) return false;
    const current = transport(this.store.ctx.state.snapshot()).requests.find(item => item.requestId === record.requestId);
    if (!current || this.terminal(current) || current.paymentIntentId !== record.paymentIntentId || current.payloadRef !== record.payloadRef) return false;
    // A failed lookup proves nothing. Keep the original authorization under observation even when
    // the recovery service itself is down, so finalized chain evidence can still clear the hold.
    if (!result || lookup.aborted || (result.status !== 200 && result.status !== 404))
      return this.checkUnusedAuthorization(record, signal, true);
    if (result.status === 404) return this.checkUnusedAuthorization(record, signal);
    if (result.body.byteLength > 65536) return false;
    const bill = JSON.parse(Buffer.from(result.body).toString("utf8")) as Record<string, unknown>;
    requireWallet(bill && typeof bill.request_id === "string" && bill.request_id.length > 0 && bill.request_id.length <= 256,
      "RPC_EVIDENCE_INVALID", "The original service bill is missing its identity.");
    if (bill.authorization_released === true && bill.payment === "not_required" && (bill.amount === null || bill.amount === "0")) {
      // Only this fixed recovery channel may record the waiver. It releases scheduling, never the reservation.
      let waived = false;
      await this.admission.recover(signal, () => this.store.ctx.state.mutate(state => {
        signal.throwIfAborted();
        const intent = state.intents.find(item => item.intentId === record.paymentIntentId);
        if (!intent?.upto || intent.waiverContradicted || intent.spent || intent.billAmountAtomic || intent.schedulingRelease?.kind === "settled" ||
          (intent.billRequestId && intent.billRequestId !== bill.request_id)) return;
        intent.billRequestId = bill.request_id as string;
        intent.schedulingRelease = { kind: "waived" };
        waived = true;
      }));
      if (waived) return this.checkUnusedAuthorization(record, signal);
    }
    if (bill.execution === "failed" && bill.payment === "not_required" && (bill.amount === null || bill.amount === "0")) {
      await this.admission.recover(signal, () => this.store.ctx.state.mutate(state => {
        signal.throwIfAborted();
        const intent = state.intents.find(item => item.intentId === record.paymentIntentId);
        requireWallet(intent?.upto && !intent.spent && !intent.billAmountAtomic,
          "RPC_EVIDENCE_INVALID", "A failed execution cannot replace settlement evidence.");
        if (intent.billRequestId) requireWallet(intent.billRequestId === bill.request_id,
          "RPC_EVIDENCE_INVALID", "The original bill identity changed.");
        intent.billRequestId = bill.request_id as string;
        // The bill cannot revoke the signed authorization or release its reservation.
      }));
      return this.checkUnusedAuthorization(record, signal);
    }
    if (bill.payment !== "settled") {
      // A pending bill binds the original authorization too. Keep the identity without releasing funds.
      const billId = bill.request_id;
      const seen = this.store.ctx.state.snapshot().intents.find(item => item.intentId === record.paymentIntentId)?.billRequestId;
      const pending = bill.payment === "authorized" || bill.payment === "settling" || bill.payment === "unknown";
      if (pending && seen !== billId) await this.admission.recover(signal, () => this.store.ctx.state.mutate(state => {
        const intent = state.intents.find(item => item.intentId === record.paymentIntentId);
        requireWallet(intent?.upto && (intent.billRequestId === undefined || intent.billRequestId === billId),
          "RPC_EVIDENCE_INVALID", "The original bill identity changed.");
        intent.billRequestId = billId;
      }));
      await this.reconciliation.resolve(record.paymentIntentId, signal, active => this.admission.acquireRecovery(active));
      return false;
    }
    requireWallet(typeof bill.amount === "string" && /^[1-9][0-9]{0,77}$/.test(bill.amount) &&
      typeof bill.tx_hash === "string" && /^0x[0-9a-f]{64}$/i.test(bill.tx_hash),
      "RPC_EVIDENCE_INVALID", "The service bill has no bounded settlement amount and transaction.");
    await this.admission.recover(signal, () => this.store.ctx.state.mutate(state => {
      signal.throwIfAborted();
      const intent = state.intents.find(item => item.intentId === record.paymentIntentId);
      requireWallet(intent?.upto && BigInt(bill.amount as string) <= BigInt(intent.amountAtomic) &&
        (!intent.billAmountAtomic || intent.billAmountAtomic === bill.amount) &&
        (!intent.billRequestId || intent.billRequestId === bill.request_id),
        "RPC_EVIDENCE_INVALID", "The original service bill changed or exceeds its authorization.");
      intent.billAmountAtomic = bill.amount as string;
      intent.billRequestId = bill.request_id as string;
    }));
    const settled = await this.reconciliation.settle(record.paymentIntentId, bill.tx_hash, signal, active => this.admission.acquireRecovery(active));
    await this.store.update(record.requestId, value => { value.paymentStatus = settled.status.toLowerCase(); });
    return false;
  }
  /**
   * A missing or failed bill cannot revoke a signature. Host time only schedules checks; finalized
   * chain evidence proves expiry. Reuse the one-hour retry bound even for successful pending reads:
   * finalized may lag expiry by more than 15 minutes. Unresolved records retain their reservation.
   */
  private async checkUnusedAuthorization(record: RequestRecord, signal: AbortSignal, lookupUnavailable = false): Promise<boolean> {
    // A changed observed settlement already handed off to full recovery. Its next follow-up
    // uses the settlement evidence; a lookup outage cannot turn it into an unused authorization.
    if (this.observed(record)) return false;
    const intent = this.store.ctx.state.snapshot().intents.find(item => item.intentId === record.paymentIntentId);
    if (!intent) return false;
    const nowSeconds = Math.floor(this.store.env.wall() / 1000), due = intent.validBefore + 60;
    if (nowSeconds <= due) {
      const untilExpiry = (due - nowSeconds + 1) * 1000;
      this.recheck(record.requestId, lookupUnavailable ? Math.min(120000, untilExpiry) : untilExpiry);
      return false;
    }
    let evidenceRead = false;
    try {
      await this.reconciliation.resolve(record.paymentIntentId!, signal, active => {
        evidenceRead = true;
        return this.admission.acquireRecovery(active);
      });
    } catch (error) {
      if (signal.aborted) return false;
      if (evidenceRead || (error instanceof WalletError && error.code === "RPC_BUSY")) {
        if (nowSeconds <= intent.validBefore + 3600) this.recheck(record.requestId, 120000);
        return false;
      }
      // No proof committed. The next recover-only lookup revalidates the record before reading again.
    }
    if (this.terminal(record)) return true;
    if (nowSeconds > intent.validBefore + 3600)
      this.stalled.add(record.requestId);
    else this.recheck(record.requestId, 120000);
    return true;
  }
  private recheck(id: string, delayMs: number): void {
    if (this.closed || this.rechecks.has(id)) return;
    const controller = new AbortController();
    this.rechecks.set(id, controller);
    this.store.env.delay(Math.min(delayMs, 900000), controller.signal).then(() => {
      this.rechecks.delete(id);
      const record = transport(this.store.ctx.state.snapshot()).requests.find(item => item.requestId === id);
      if (this.closed || !record || this.terminal(record) || this.stalled.has(id)) return;
      this.queue(record);
      this.pump();
    }, () => { this.rechecks.delete(id); });
  }
  /**
   * Follows an observed settlement until safe: 20 s, 30 s, then every 60 s for at most 15 minutes.
   * It only reads the chain, outside the admission lease and the control fence. Changed evidence
   * or an orphaned transaction ends it; full recovery handles that at the next readiness trigger.
   */
  private async followUp(id: string, signal: AbortSignal): Promise<void> {
    const started = this.store.env.monotonic();
    for (let step = 0; ; step++) {
      const wait = step === 0 ? 20000 : step === 1 ? 30000 : 60000;
      if (this.store.env.monotonic() - started + wait > 900000) return;
      await this.store.env.delay(wait, signal);
      if (signal.aborted) return;
      const record = transport(this.store.ctx.state.snapshot()).requests.find(item => item.requestId === id);
      if (!record || !this.observed(record)) return;
      let outcome: "confirmed" | "observed" | "unchanged";
      try {
        const lease = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
        outcome = await this.reconciliation.confirmObserved(record.paymentIntentId!,
          AbortSignal.any([signal, AbortSignal.timeout(15000)]), write => this.admission.recover(lease, write));
      } catch {
        if (signal.aborted) return;
        continue; // A busy, rate-limited or failed read proves nothing; try again at the next step.
      }
      if (outcome === "unchanged") {
        // Only full reconciliation may apply a reorg or reject changed evidence.
        if (this.observed(record)) { this.fullRecovery.add(id); this.pending.add(id); }
        return;
      }
      if (outcome === "confirmed") {
        await this.store.update(id, value => { value.paymentStatus = "confirmed"; });
        return;
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.pending.clear();
    this.followPending.clear();
    this.fullRecovery.clear();
    this.stalled.clear();
    for (const controller of this.rechecks.values()) controller.abort();
    this.rechecks.clear();
    const jobs = [...this.active.values(), ...this.following.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map(job => job.done));
  }
}
