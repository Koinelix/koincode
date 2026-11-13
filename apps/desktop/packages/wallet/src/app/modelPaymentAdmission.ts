import { paymentQueueTiming, paymentStage } from "./paymentTiming.js";
import { UptoAdmission } from "./uptoAdmission.js";
import type { RequestStore } from "./requestStore.js";
import type { WalletPayments } from "./payments.js";
import type { ClientHandle } from "./sessions.js";
import { hostPaymentJournalInput, validateHostPayment } from "./hostPayments.js";
import { ownedOperation } from "./transportState.js";
import { requestDigest } from "./requestFacts.js";
import { parseQuote } from "./requestQuote.js";
import { requireWallet, WalletError } from "../domain/errors.js";

/**
 * The wallet owner admits an unsigned model operation before its quote is refreshed. Payments the existing
 * allowance covers are admitted side by side; one that must replace the allowance is admitted alone.
 */
export class ModelPaymentAdmission {
  private readonly queue: UptoAdmission;
  private readonly prepared = new Map<string, { walletId: string; epoch: string; amountAtomic: bigint; intentId?: string }>();
  private readonly checking = new Set<string>();
  private readonly blockedByAllowance = new Set<string>();
  private readonly invocations = new Map<string, string>();
  private readonly ownerKey = "wallet-model-owner";
  constructor(private readonly store: RequestStore, private readonly payments: WalletPayments) {
    this.queue = new UptoAdmission(store.env.monotonic, store.env.delay);
  }
  private binding(handle: ClientHandle, operationId: string) {
    const state = this.store.ctx.state.snapshot(), context = this.store.ctx.sessions.resolve(handle, state);
    const wallet = state.wallets.find(item => item.walletId === state.defaultWalletId);
    requireWallet(wallet && state.clients.some(client => client.clientId === context.clientId && client.kind === "internal"),
      "CLIENT_AUTHENTICATION_REQUIRED", "The internal model wallet is unavailable.");
    return { wallet, context, state, owner: JSON.stringify([context.clientId, context.sessionId, context.generation, operationId]) };
  }
  /** A shared ceiling moves to the durable ledger before its signer releases admission. */
  private heldAtomic(walletId: string, owner: string, ledgerIds: ReadonlySet<string>): bigint {
    let total = 0n;
    for (const peer of this.queue.sharedOwners(this.ownerKey, owner)) {
      const hold = this.prepared.get(peer);
      if (hold?.walletId === walletId && !(hold.intentId && ledgerIds.has(hold.intentId))) total += hold.amountAtomic;
    }
    return total;
  }
  displayHolds(walletId: string, ledgerIds: ReadonlySet<string>) {
    let total = 0n;
    const quotes: string[] = [];
    for (const [owner, hold] of this.prepared) {
      if (walletId !== hold.walletId || !this.queue.mode(this.ownerKey, owner)) continue;
      quotes.push(hold.amountAtomic.toString());
      if (!hold.intentId || !ledgerIds.has(hold.intentId)) total += hold.amountAtomic;
    }
    return { total, quotes };
  }
  reserved(handle: ClientHandle, operationId: string, intentId: string): void {
    const hold = this.prepared.get(this.binding(handle, operationId).owner);
    if (hold) hold.intentId = intentId;
  }
  assertInvocation(handle: ClientHandle, operationId: string, digest?: string): void {
    const { owner } = this.binding(handle, operationId);
    if (this.queue.owns(this.ownerKey, owner))
      requireWallet(this.invocations.get(owner) === digest, "PAYMENT_CONTEXT_CHANGED", "The admission belongs to another model invocation.");
  }
  async acquire(handle: ClientHandle, operationId: string, raw: unknown, signal: AbortSignal, digest?: string): Promise<{ waited: boolean }> {
    const input = validateHostPayment(raw), { wallet, owner } = this.binding(handle, operationId);
    const quote = parseQuote(input.paymentRequired, input.url, this.store.env.wall(), this.store.env.monotonic(),
      "admission-only", undefined, this.store.ctx.paymentNetwork);
    requireWallet(quote.selected.scheme === "upto", "X402_UNSUPPORTED_PAYMENT", "Model admission requires an upto quote.");
    const url = new URL(input.url), selected = quote.selected;
    const scope = { scheme: "upto" as const, subjectId: wallet.subjectId, requestId: operationId,
      requestDigest: input.requestDigest, quoteDigest: quote.digest, credentialVersion: "anonymous",
      origin: url.origin, path: url.pathname, method: input.method, network: selected.network, asset: selected.asset,
      payTo: selected.payTo, amountAtomic: selected.amount };
    const contextSignal = AbortSignal.any([signal, this.store.ctx.state.walletSelectionSignal,
      this.store.ctx.sessions.invalidationSignal(handle)]);
    let allowanceWait = 0, queueWait = 0;
    let interruptedAt: number | undefined;
    const staleObservation = new Error("Unsigned allowance observation superseded by reconciliation.");
    for (const key of this.invocations.keys()) if (!this.queue.owns(this.ownerKey, key)) this.invocations.delete(key);
    this.assertInvocation(handle, operationId, digest);
    if (digest) this.invocations.set(owner, digest);
    return paymentStage(operationId, "admission", () => this.queue.acquire(this.ownerKey, owner, contextSignal, async (admissionSignal, grant) => {
      const current = this.binding(handle, operationId);
      requireWallet(current.wallet.walletId === wallet.walletId && current.owner === owner,
        "PAYMENT_CONTEXT_CHANGED", "The selected payment account changed while waiting.");
      const prior = ownedOperation(current.state, current.context, operationId);
      requireWallet(!prior?.paymentIntentId && !prior?.payloadRef, "REQUEST_NOT_RESUMABLE", "A signed operation cannot restart unsigned admission.");
      const fence = this.store.ctx.fence;
      if (interruptedAt !== undefined) {
        requireWallet(fence.onlyRecoverySince(interruptedAt), "PAYMENT_CONTEXT_CHANGED", "Wallet control changed before the admission recheck.");
        const record = ownedOperation(current.state, current.context, operationId);
        if (record) {
          requireWallet(record.inputDigest === requestDigest(hostPaymentJournalInput(input, true)), "REQUEST_CONFLICT", "The prepared purchase changed.");
          requireWallet(!record.canceled && !record.paymentIntentId && !record.payloadRef &&
            record.sessionId === current.context.sessionId && record.generation === current.context.generation &&
            ["awaiting_authorization", "waiting_for_unlock"].includes(record.transportStatus) &&
            !current.state.intents.some(intent => intent.clientId === record.clientId && intent.requestId === record.requestId),
          "REQUEST_NOT_RESUMABLE", "A possible payment cannot restart unsigned admission.");
        }
      }
      // Share with other payments while rechecking, but hold queued proof writes until the decision.
      const protectedRead = interruptedAt !== undefined;
      if (protectedRead && !grant("shared")) return false;
      const security = fence.capture();
      const checkObservation = () => {
        admissionSignal.throwIfAborted();
        if (fence.onlyRecoverySince(security)) {
          interruptedAt = security;
          throw staleObservation;
        }
        fence.assertCurrent(security);
      };
      const entry = { walletId: wallet.walletId, epoch: this.store.ctx.state.snapshot().managementEpoch, amountAtomic: BigInt(selected.amount) };
      let deciding = false;
      try {
        await this.payments.prepareUpto(handle, scope, selected.extra.facilitatorAddress!, selected.maxTimeoutSeconds,
          Boolean((quote.challenge.extensions as Record<string, unknown> | undefined)?.eip2612GasSponsoring), admissionSignal, {
            onChainRead: active => {
              if (active) this.checking.add(owner);
              else this.checking.delete(owner);
            },
            heldAtomic: ids => {
              checkObservation();
              return this.heldAtomic(wallet.walletId, owner, ids);
            },
            decide: authorization => {
              deciding = true;
              this.blockedByAllowance.delete(owner);
              const unattended = authorization.upto.permitNonce === null && this.payments.signsUnattended(handle, scope);
              if (protectedRead) this.queue.assert(this.ownerKey, owner);
              requireWallet(grant(unattended ? "shared" : "exclusive", unattended ? entry.amountAtomic : undefined),
                "PAYMENT_QUEUE_REQUIRED", "Another payment of this wallet must finish its authorization first.");
              this.prepared.set(owner, entry);
            },
          });
        checkObservation();
      } catch (error) {
        if (error === staleObservation) return "recheck" as const;
        if (!deciding && error instanceof WalletError && error.code === "PAYMENT_QUEUE_REQUIRED") this.blockedByAllowance.add(owner);
        throw error;
      } finally { this.checking.delete(owner); }

      this.prepared.set(owner, entry);
      return true;
    }, duration => {
      if (this.blockedByAllowance.has(owner)) allowanceWait += duration;
      else queueWait += duration;
    }, "payment", BigInt(selected.amount)).finally(() => {
      paymentQueueTiming(operationId, "allowance_wait", allowanceWait);
      paymentQueueTiming(operationId, "authorization_queue", queueWait);
      if (!this.queue.mode(this.ownerKey, owner)) this.prepared.delete(owner);
      if (!this.queue.owns(this.ownerKey, owner)) this.invocations.delete(owner);
      if (!this.queue.isWaiting(owner)) this.blockedByAllowance.delete(owner);
    }));
  }
  async acquireRecovery(signal: AbortSignal): Promise<() => void> {
    const owner = `recovery:${crypto.randomUUID()}`;
    await this.queue.acquire(this.ownerKey, owner, signal, async () => true, undefined, "proof_write");
    try {
      const releaseProof = await this.store.ctx.fence.acquireProofWrite(signal);
      return () => { releaseProof(); this.queue.release(this.ownerKey, owner); };
    } catch (error) { this.queue.release(this.ownerKey, owner); throw error; }
  }
  async recover(signal: AbortSignal, action: () => Promise<void>): Promise<void> {
    const release = await this.acquireRecovery(signal);
    try { signal.throwIfAborted(); await action(); } finally { release(); }
  }
  coverRefreshedQuote(handle: ClientHandle, operationId: string, raw: unknown, digest?: string) {
    this.assertInvocation(handle, operationId, digest);
    this.assert(handle, operationId);
    const { owner } = this.binding(handle, operationId);
    const payment = validateHostPayment(raw);
    const quote = parseQuote(payment.paymentRequired, payment.url, this.store.env.wall(), this.store.env.monotonic(),
      "admission-only", undefined, this.store.ctx.paymentNetwork);
    const hold = this.prepared.get(owner)!;
    const ceiling = BigInt(quote.selected.amount);
    if (ceiling > hold.amountAtomic)
      throw new WalletError("MODEL_QUOTE_INCREASED", "The refreshed quote needs a new unsigned admission.");
    if (ceiling < hold.amountAtomic) {
      hold.amountAtomic = ceiling;
      if (!hold.intentId) this.queue.capacityChanged(this.ownerKey);
    }
  }
  /** A payment admitted beside others that turns out to need the user gives up its place and is admitted alone. */
  async alone(handle: ClientHandle, operationId: string, signal: AbortSignal): Promise<void> {
    const { owner } = this.binding(handle, operationId);
    if (this.queue.mode(this.ownerKey, owner) !== "shared") return;
    const preparation = this.prepared.get(owner);
    this.queue.release(this.ownerKey, owner);
    this.prepared.delete(owner);
    await this.queue.acquire(this.ownerKey, owner, AbortSignal.any([signal, this.store.ctx.state.walletSelectionSignal,
      this.store.ctx.sessions.invalidationSignal(handle)]), async (_signal, grant) => grant("exclusive"));
    if (preparation) this.prepared.set(owner, preparation);
  }
  status(handle: ClientHandle, operationId: string) {
    const { owner } = this.binding(handle, operationId);
    if (this.checking.has(owner)) return { waiting: true, reason: "chain" };
    if (this.blockedByAllowance.has(owner)) return { waiting: true, reason: "allowance" };
    if (this.queue.isWaiting(owner)) return { waiting: true, reason: "queue" };
    return { waiting: false };
  }
  isWaiting(handle: ClientHandle, operationId: string): boolean {
    return this.queue.isWaiting(this.binding(handle, operationId).owner);
  }
  assert(handle: ClientHandle, operationId: string): { shared: boolean } {
    const { wallet, owner } = this.binding(handle, operationId);
    this.queue.assert(this.ownerKey, owner);
    const preparation = this.prepared.get(owner);
    requireWallet(preparation?.walletId === wallet.walletId,
      "PAYMENT_CONTEXT_CHANGED", "The prepared payment wallet changed.");
    requireWallet(preparation.epoch === this.store.ctx.state.snapshot().managementEpoch,
      "PAYMENT_CONTEXT_CHANGED", "The wallet management epoch changed.");
    return { shared: this.queue.mode(this.ownerKey, owner) === "shared" };
  }
  release(handle: ClientHandle, operationId: string): void {
    const { owner } = this.binding(handle, operationId);
    this.queue.cancel(this.ownerKey, owner);
    this.prepared.delete(owner);
  }
}
