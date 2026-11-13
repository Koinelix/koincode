import { uptoAvailability } from "../domain/uptoScheduling.js";
import { uptoTypedData, parseUptoTypedData, type UptoAuthorization } from "../domain/uptoAuthorization.js";
import { cappedAllowance, pendingAllowanceChange, refreshAllowanceChange } from "./walletAllowance.js";
import { modelDirectPayment, Permit2NonceAllocator, uptoAtSnapshot, type UptoTerms } from "./uptoPreparation.js";
import { paymentStage } from "./paymentTiming.js";
import { sameAuthorization, scopeInput } from "../domain/signingScope.js";
import { reservePayment } from "./paymentReservation.js";
import { replacementGrant } from "./paymentReplacement.js";
import { releaseUnsigned } from "./unsignedRelease.js";
import { randomUUID } from "node:crypto";
import { checkBudget } from "../domain/budget.js";
import { parseSdkAuthorization } from "../domain/authorization.js";
import { checkGrant } from "../domain/grants.js";
import { requireWallet, WalletError } from "../domain/errors.js";
import type { PaymentGrant, PaymentScope } from "../domain/model.js";
import type { WalletState } from "./state.js";
import type { ClientHandle } from "./sessions.js";
import { isUnsignedSigningFailure } from "./signingProof.js";
import { audit, type RuntimeContext } from "./runtimeContext.js";
import { assertUndisputed, commitEvidence, checkWaivedNonces, needsSettlementCheck, modelObservation, paymentSnapshot, signingEvidence } from "./paymentSigningEvidence.js";
import { outstandingAtSnapshot } from "./settlementProof.js";
export { proveSettlementAnchors } from "./settlementProof.js";

// Owned by the trusted request adapter. It is never exposed as a model tool.
export class WalletPayments {
  readonly #permit2Nonces = new Permit2NonceAllocator();
  #active = new Set<Promise<void>>();
  constructor(private readonly ctx: RuntimeContext) {}
  async drain(): Promise<void> {
    await Promise.allSettled(this.#active);
  }
  lookup(handle: ClientHandle, subjectId: string, requestId: string) {
    const state = this.ctx.state.snapshot();
    const context = this.ctx.sessions.requireSubject(handle, subjectId, state);
    const intent = state.intents.findLast(
      (intent) =>
        intent.subjectId === subjectId &&
        intent.clientId === context.clientId &&
        intent.requestId === requestId,
    );
    return {
      continuityValid: this.ctx.state.continuityValid(),
      payment: intent
        ? {
            intentId: intent.intentId,
            status: intent.status,
            reserved: intent.reserved,
            spent: intent.spent,
          }
        : null,
    };
  }
  private pickGrant(
    state: WalletState,
    handle: ClientHandle,
    scope: PaymentScope,
    now: number,
  ): PaymentGrant {
    const context = this.ctx.sessions.requireSubject(handle, scope.subjectId, state);
    const rank = { once: 0, session: 1, persistent: 2 };
    for (const grant of [...state.grants].sort((a, b) => rank[a.scope] - rank[b.scope])) {
      try {
        checkGrant(grant, scope, context, state.managementEpoch, now, this.ctx.sessions.hostGrantScope(handle));
        return grant;
      } catch (error) {
        if (!(error instanceof WalletError)) throw error;
      }
    }
    throw new WalletError(
      "PAYMENT_APPROVAL_REQUIRED",
      "No active grant covers this exact purchase.",
    );
  }
  /** True when a standing grant and an unlocked wallet let this purchase be signed without asking the user. */
  signsUnattended(handle: ClientHandle, scope: PaymentScope): boolean {
    try {
      const state = this.ctx.state.snapshot(), now = this.ctx.clock.now();
      const wallet = state.wallets.find(item => item.subjectId === scope.subjectId);
      return Boolean(wallet && this.ctx.unlocks.isUnlocked(wallet.walletId) && this.pickGrant(state, handle, scope, now).scope !== "once");
    } catch (error) {
      if (!(error instanceof WalletError)) throw error;
      return false;
    }
  }
  /** `admission` decides in the same step as the allowance check, so concurrent checks never share one observation. */
  async prepareUpto(handle: ClientHandle, scope: PaymentScope, facilitator: string, timeout: number, sponsoring: boolean, signal?: AbortSignal,
    admission?: { onChainRead?(active: boolean): void; heldAtomic(ids: ReadonlySet<string>): bigint; decide(authorization: UptoAuthorization): void }): Promise<UptoAuthorization> {
    const ctx = this.ctx, state = ctx.state.snapshot();
    ctx.sessions.requireSubject(handle, scope.subjectId, state);
    const wallet = state.wallets.find(item => item.subjectId === scope.subjectId);
    requireWallet(wallet && scope.network === ctx.paymentNetwork && wallet.network === scope.network && ctx.chain.uptoSnapshot,
      "PAYMENT_NETWORK_MISMATCH", "The fixed upto wallet is unavailable.");
    if (pendingAllowanceChange(state, wallet.subjectId)) await refreshAllowanceChange(ctx, wallet, signal ?? ctx.fence.signal, admission?.onChainRead);
    const intents = state.intents.filter(item => item.subjectId === scope.subjectId && item.upto);
    const direct = admission && modelDirectPayment(state, scope, wallet.walletId, facilitator);
    const holds = admission?.heldAtomic(new Set(intents.map(i => i.intentId)));
    const observation = await paymentStage(scope.requestId, "admission_chain", async () => admission
      ? modelObservation(ctx, wallet, intents, BigInt(scope.amountAtomic) + (holds ?? 0n), signal, false, admission.onChainRead, holds, direct,
        Boolean(pendingAllowanceChange(state, wallet.subjectId)))
      : { snapshot: await paymentSnapshot(ctx, wallet, intents, signal), cached: false });
    const { snapshot } = observation;
    if (observation.cached) ctx.clock.now();
    else ctx.clock.update(snapshot.latest.timestamp, ctx.state.snapshot().trustedTime);
    await checkWaivedNonces(ctx, intents, snapshot.usedNonces);
    // Reservations committed during the chain read are unknown to its nonce list and therefore count as in flight.
    const latest = ctx.state.snapshot();
    const current = latest.intents.filter(item => item.subjectId === scope.subjectId && item.upto);
    const pending = pendingAllowanceChange(latest, wallet.subjectId);
    const authorization = uptoAtSnapshot(scope, wallet.address, current, cappedAllowance(snapshot, pending), { facilitator, timeout, sponsoring },
      admission?.heldAtomic(new Set(current.map(intent => intent.intentId))) ?? 0n, observation.cached || Boolean(pending), undefined, direct);
    admission?.decide(authorization);
    return authorization;
  }

  async sign(
    handle: ClientHandle,
    scopeInputValue: PaymentScope,
    typedInput: unknown,
    signal?: AbortSignal,
    constraints?: {
      assertCurrent?: () => void;
      replacementFrom?: string;
      unsignedRetryFrom?: string;
      maxTimeoutSeconds?: number;
      upto?: UptoAuthorization;
      uptoTerms?: UptoTerms;
      /** Admitted beside other payments of this wallet: spend only the existing allowance, never replace it. */
      uptoShared?: boolean;
      onReserved?: (intentId: string) => void;
    },
  ): Promise<{ intentId: string; signature: string; permitSignature?: string; upto?: UptoAuthorization }> {
    const scope = Object.freeze(structuredClone(scopeInputValue));
    let typedData = structuredClone(typedInput);
    scopeInput(scope);
    const ctx = this.ctx;
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.#active.add(done);
    let job: Awaited<ReturnType<typeof ctx.fence.startPayment>> | undefined;
    let intentId: string | null = null, releaseSigner: (() => void) | undefined;
    try {
      job = await ctx.fence.startPayment(signal);
      const security = job.generation, cancel = AbortSignal.any([job.controller.signal, ...(signal ? [signal] : [])]);
      ctx.fence.assertCurrent(security);
      constraints?.assertCurrent?.();
      const initial = ctx.state.snapshot();
      const client = ctx.sessions.requireSubject(handle, scope.subjectId, initial);
      const wallet = initial.wallets.find((wallet) => wallet.subjectId === scope.subjectId);
      requireWallet(
        wallet &&
          wallet.network === scope.network &&
          wallet.asset.toLowerCase() === scope.asset.toLowerCase(),
        "PERMIT_MISMATCH",
        "The purchase does not match a managed wallet.",
      );
      requireWallet(
        scope.network === ctx.paymentNetwork,
        "PAYMENT_NETWORK_MISMATCH",
        "The payment network differs from the fixed wallet network.",
      );
      const unlock = ctx.unlocks.capture(wallet.walletId);
      const interaction = ctx.unlocks.interactionGeneration;
      let upto = constraints?.upto;
      const terms = constraints?.uptoTerms;
      requireWallet(!(upto && terms), "PERMIT_MISMATCH", "Conflicting upto signing inputs.");
      requireWallet((scope.scheme === "upto") === Boolean(upto || terms), "PERMIT_MISMATCH", "The payment scheme differs from its signing intent.");
      const modelRequest = terms && initial.transport?.requests.some(record => record.modelPayment &&
        record.requestId === scope.requestId && record.clientId === client.clientId && record.frozenDigest === scope.requestDigest);
      const direct = terms && modelRequest
        ? modelDirectPayment(initial, scope, wallet.walletId, terms.facilitator) : undefined;
      const observe = (force = false) => signingEvidence(ctx, scope, wallet, initial, Boolean(upto || terms), cancel,
        Boolean(terms && constraints?.uptoShared && !pendingAllowanceChange(initial, wallet.subjectId)), force, direct, Boolean(modelRequest));
      let evidence = await observe();
      let now = evidence.cached ? ctx.clock.now() : ctx.clock.update(evidence.snapshot.latest.timestamp, initial.trustedTime);
      if (ctx.custody.acquireSigningSlot) {
        releaseSigner = await ctx.custody.acquireSigningSlot(cancel);
        constraints?.assertCurrent?.();
        ctx.fence.assertCurrent(security);
        requireWallet(!cancel.aborted, "WALLET_OPERATION_ABORTED", "The purchase was canceled.");
        if (!evidence.fresh()) {
          evidence = await observe();
          now = evidence.cached ? ctx.clock.now() : ctx.clock.update(evidence.snapshot.latest.timestamp, ctx.state.snapshot().trustedTime);
        } else now = ctx.clock.now();
      }
      const { snapshot, proven } = evidence;
      assertUndisputed(snapshot);
      if (terms) {
        const pending = pendingAllowanceChange(initial, wallet.subjectId);
        upto = uptoAtSnapshot(scope, wallet.address, initial.intents.filter(item => item.subjectId === scope.subjectId && item.upto),
          cappedAllowance(snapshot as import("./ports.js").UptoChainSnapshot, pending), terms, 0n, constraints?.uptoShared === true || Boolean(pending), this.#permit2Nonces, direct);
        typedData = uptoTypedData(upto);
      }
      const shared = constraints?.uptoShared === true && upto?.upto.permitNonce === null;
      if (upto) {
        const used = new Set((snapshot as import("./ports.js").UptoChainSnapshot).usedNonces);
        const invalid = initial.intents.filter(intent => intent.subjectId === scope.subjectId && needsSettlementCheck(intent, snapshot.finalized.timestamp) &&
          (!used.has(intent.nonce) || intent.settlementBlock === undefined || intent.settlementHash === undefined ||
            !proven.has(`${intent.settlementBlock}:${intent.settlementHash.toLowerCase()}`)));
        if (invalid.length) {
          await ctx.state.mutate(state => { for (const old of invalid) {
            const current = state.intents.find(intent => intent.intentId === old.intentId);
            if (current?.schedulingRelease?.kind === "settled") delete current.schedulingRelease;
          } });
          throw new WalletError("PAYMENT_CONTEXT_CHANGED", "A tentative release changed; its allowance reservation has been restored.");
        }
      }
      const authorization = Object.freeze(
        upto ? parseUptoTypedData(typedData, upto) : parseSdkAuthorization(typedData, scope, wallet.address, now),
      );
      const timeoutCap = constraints?.maxTimeoutSeconds ?? 120;
      requireWallet(
        Number.isSafeInteger(timeoutCap) &&
          timeoutCap > 0 &&
          timeoutCap <= (upto ? 900 : 120) &&
          authorization.validBefore > now + (upto ? timeoutCap - 60 : 5) &&
          authorization.validBefore <= now + timeoutCap + (upto ? 120 : 0),
        "AUTHORIZATION_WINDOW_INVALID",
        "The actual authorization exceeds the exact quote timeout.",
      );
      requireWallet(
        BigInt(snapshot.balanceAtomic) >= BigInt(scope.amountAtomic),
        "INSUFFICIENT_BALANCE",
        "The anchored token balance is insufficient.",
      );
      const prepared = await paymentStage(scope.requestId, "reserve_commit", () => ctx.state.mutate((state) => {
        ctx.fence.assertCurrent(security);
        ctx.unlocks.assertCurrent(wallet.walletId, unlock);
        requireWallet(!cancel.aborted, "WALLET_OPERATION_ABORTED", "The purchase was canceled.");
        const checked = commitEvidence(ctx, evidence, upto, state.intents);
        const reservation = reservePayment(state, { ctx, initial, wallet, handle, scope, ...checked, now, timeoutCap, shared, direct,
          authorization, upto, constraints, pickGrant: () => this.pickGrant(state, handle, scope, now) });
        // A peer counts the temporary hold until this exact ID appears in its committed snapshot.
        constraints?.onReserved?.(reservation.intent.intentId);
        return reservation;
      }));
      intentId = prepared.intent.intentId;
      let signature: string, permitSignature: string | undefined;
      let firstSigned = false;
      try {
        const finalCheck = (actual: Readonly<import("../domain/model.js").ExactAuthorization>) => {
            constraints?.assertCurrent?.();
            ctx.fence.assertCurrent(security);
            ctx.unlocks.assertCurrent(wallet.walletId, unlock);
            requireWallet(
              ctx.state.continuityValid() && !cancel.aborted,
              "WALLET_OPERATION_ABORTED",
              "The payment security context is unavailable.",
            );
            const state = ctx.state.snapshot(),
              current = state.intents.find((intent) => intent.intentId === intentId)!;
            const checked = commitEvidence(ctx, evidence, upto, state.intents);
            if (upto && (shared || checked.snapshot !== snapshot)) {
              const open = uptoAvailability(state.intents.filter(item => item.subjectId === scope.subjectId && item.upto),
                { ...cappedAllowance(checked.snapshot as import("./ports.js").UptoChainSnapshot, pendingAllowanceChange(state, wallet.subjectId)),
                  finalizedTimestamp: checked.snapshot.finalized.timestamp }, direct, upto.validAfter);
              requireWallet(!open.permitPending && open.availableAtomic >= 0n,
                "PAYMENT_CONTEXT_CHANGED", "Outstanding authorizations exceed the allowance before the native signing commitment.");
            }
            if (upto && !shared) {
              requireWallet(JSON.stringify(state.intents.filter(item => item.subjectId === scope.subjectId && item.intentId !== intentId)) ===
                JSON.stringify(initial.intents.filter(item => item.subjectId === scope.subjectId)),
                "PAYMENT_CONTEXT_CHANGED", "Outstanding authorizations changed before the native signing commitment.");
            }
            const permit = state.permits.find((permit) => permit.permitId === prepared.permitId);
            const currentNow = ctx.clock.now();
            requireWallet(
              permit &&
                permit.status === "consumed" &&
                permit.expiresAt > currentNow &&
                current.status === "SIGNING" &&
                current.reserved &&
                !current.spent &&
                current.managementEpoch === state.managementEpoch,
              "PERMIT_MISMATCH",
              "The precise signing permit is no longer valid.",
            );
            const context = ctx.sessions.requireSubject(handle, current.subjectId, state);
            const grant = state.grants.find((grant) => grant.grantId === current.grantId)!;
            const policy = state.policies[current.subjectId]!;
            requireWallet(outstandingAtSnapshot(state, current.walletId, checked.snapshot, checked.proven) <= BigInt(checked.snapshot.balanceAtomic),
              "INSUFFICIENT_BALANCE", "The anchored balance cannot cover all outstanding authorizations.");
            requireWallet(
              grant.version === current.grantVersion && policy.version === current.policyVersion,
              "PAYMENT_CONTEXT_CHANGED",
              "Payment policy changed before signing.",
            );
            const effectiveGrant = current.replacesIntentId
              ? replacementGrant(
                  {
                    ...state,
                    intents: state.intents.filter((x) => x.intentId !== current.intentId),
                  },
                  state.intents.find((x) => x.intentId === current.replacesIntentId)!,
                  current,
                )
              : grant;
            checkGrant(
              effectiveGrant.scope === "once" && effectiveGrant.status === "consumed"
                ? { ...effectiveGrant, status: "active" }
                : effectiveGrant,
              current,
              context,
              state.managementEpoch,
              currentNow,
              ctx.sessions.hostGrantScope(handle),
            );
            checkBudget(
              state.subjects.find((subject) => subject.subjectId === current.subjectId)!,
              policy,
              state.events.filter((event) => event.intentId !== current.intentId),
              current.amountAtomic,
              currentNow,
            );
            const rechecked = upto ? parseUptoTypedData(typedData, upto) : parseSdkAuthorization(typedData, current, wallet.address, currentNow);
            requireWallet(
              sameAuthorization(actual, authorization) && sameAuthorization(actual, rechecked),
              "PERMIT_MISMATCH",
              "The actual signing authorization differs from the precise permit.",
            );
          };
        const signingContext = { walletId: wallet.walletId, subjectId: prepared.intent.subjectId, intentId: prepared.intent.intentId,
          requestId: prepared.intent.requestId, requestDigest: prepared.intent.requestDigest, quoteDigest: prepared.intent.quoteDigest };
        signature = await paymentStage(scope.requestId, "native_sign", () => ctx.custody.signAuthorization(wallet, authorization, finalCheck, cancel, signingContext));
        firstSigned = true;
        if (upto && upto.upto.permitNonce !== null) {
          requireWallet(ctx.custody.signPermitAuthorization, "PERMIT_MISMATCH", "The fixed permit signer is unavailable.");
          permitSignature = await paymentStage(scope.requestId, "native_permit", () => ctx.custody.signPermitAuthorization!(wallet, upto!, finalCheck, cancel, signingContext));
        }
      } catch (error) {
        const unsigned = !firstSigned && isUnsignedSigningFailure(error);
        const canceledInteraction = unsigned && error instanceof WalletError &&
          ["PAYMENT_CONTEXT_CHANGED", "WALLET_OPERATION_ABORTED", "WALLET_LOCKED"].includes(error.code) &&
          ctx.unlocks.interactionGeneration !== interaction && ctx.unlocks.isApplicationUnlocked(wallet.walletId);
        if (!canceledInteraction) ctx.unlocks.lock(wallet.walletId);
        ctx.fence.invalidate();
        if (unsigned) {
          try { await releaseUnsigned(ctx, intentId); }
          catch (failure) { ctx.unlocks.lock(wallet.walletId); throw failure; }
        }
        throw error;
      }
      releaseSigner?.();
      releaseSigner = undefined;
      let signatureRef!: string, permitSignatureRef: string | undefined;
      try {
        await paymentStage(scope.requestId, "protected_storage", async () => {
          signatureRef = await ctx.custody.protectSignature(intentId!, signature);
          if (permitSignature) permitSignatureRef = await ctx.custody.protectSignature(randomUUID(), permitSignature);
        });
      } catch {
        ctx.unlocks.lock(wallet.walletId);
        ctx.fence.invalidate();
        throw new WalletError(
          "PROTECTED_STORAGE_UNAVAILABLE",
          "The payment signature could not be protected. Its risk remains reserved.",
        );
      }
      await paymentStage(scope.requestId, "signed_commit", () => ctx.state.mutate((state) => {
        const intent = state.intents.find((intent) => intent.intentId === intentId)!;
        requireWallet(
          intent.status === "SIGNING" && intent.reserved && !intent.spent,
          "STATE_CONFLICT",
          "Signing state changed unexpectedly.",
        );
        intent.status = "SIGNED";
        intent.signatureRef = signatureRef;
        if (permitSignatureRef) intent.permitSignatureRef = permitSignatureRef;
        audit(state, "PAYMENT_SIGNED", intent.subjectId, { intentId });
      }));
      ctx.fence.assertCurrent(security);
      requireWallet(
        !cancel.aborted,
        "WALLET_OPERATION_ABORTED",
        "The signed purchase was canceled before submission.",
      );
      ctx.unlocks.touch(wallet.walletId);
      return { intentId, signature, ...(permitSignature ? { permitSignature } : {}), ...(upto ? { upto } : {}) };
    } finally {
      releaseSigner?.();
      job?.dispose();
      complete();
      this.#active.delete(done);
    }
  }
  async submitted(intentId: string): Promise<void> {
    await this.ctx.state.mutate((state) => {
      const intent = state.intents.find((intent) => intent.intentId === intentId);
      requireWallet(
        intent && ["SIGNED", "SUBMITTED", "UNKNOWN"].includes(intent.status),
        "INVALID_TRANSITION",
        "The authorization cannot be submitted.",
      );
      intent.status = "SUBMITTED";
      audit(state, "PAYMENT_SUBMITTED", intent.subjectId, { intentId });
    });
  }
}
