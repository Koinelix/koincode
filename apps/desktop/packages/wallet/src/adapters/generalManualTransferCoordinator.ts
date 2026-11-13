import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { generalSourceCommitment } from "../app/generalState.js";
import type { ProtectedStore } from "../app/ports.js";
import type { GeneralSigningRisk } from "../app/generalSigningTypes.js";
import type { SecretAdmission } from "../domain/generalSetup.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { GeneralGuardedState } from "./generalGuardedState.js";
import { bindGeneralFeeQuote, GeneralFeeQuoteReader, type GeneralFeeQuote } from "./generalFeeQuote.js";
import { GeneralPendingNonceReader } from "./generalPendingNonce.js";
import { GeneralSignedMaterialStore } from "./generalSignedMaterial.js";
import { GeneralSigningJournal } from "./generalSigningJournal.js";
import { signGeneralReadySource } from "./generalSourceSigner.js";
import { GeneralTransferApprovalOwner } from "./generalTransferApproval.js";
import { broadcastGeneralTransfer } from "./generalTransferBroadcast.js";
import { consumeGeneralTransferFunds, GeneralTransferFundsReader } from "./generalTransferFundsEvidence.js";
import { assertFreshGeneralPreparedPreview, prepareGeneralTransfer, type GeneralTransferPreview } from "./generalTransferIntent.js";
import { GeneralTransferIntentStore } from "./generalTransferIntentStore.js";
import { describeGeneralTransferSimulation, GeneralTransferSimulationReader, type GeneralTransferGasObservation } from "./generalTransferSimulation.js";
import type { GeneralRpcTransport } from "./generalRpcTransport.js";
import { GeneralTransferDraftReader } from "./generalTransferDraftReader.js";

type Draft = Omit<Parameters<typeof prepareGeneralTransfer>[0], "ownerId" | "accountAddress" | "nonce" | "now">;
type Session = { token: object; controller: AbortController; phase: "preparing" | "prepared" | "executing";
  reservation?: object; preview?: GeneralTransferPreview; removeParent: () => void; finishing?: Promise<void>;
  settled: Promise<void>; resolveSettled: () => void;
  preflight?: object;
  feeQuote?: GeneralFeeQuote; feeTimer?: ReturnType<typeof setTimeout>;
  owner?: { ownerId: string; installationId: string; sourceId: string; commitment: string } };

function transferRisk(preview: GeneralTransferPreview, riskId: string): GeneralSigningRisk {
  const asset = preview.asset.kind === "native" ? "native" as const : `erc20:${preview.asset.address}` as const;
  return { riskId, transferId: preview.transferId, intentDigest: preview.digest, accountAddress: preview.accountAddress,
    networkId: preview.networkId, nonce: preview.nonce, asset, amountAtomic: preview.amountAtomic,
    maxGasAtomic: preview.maxFeeExposureAtomic, approvalExpiresAt: preview.expiresAt };
}

/** One isolated manual operation owner. It never touches Skill payment grants, budgets or services. */
export class GeneralManualTransferCoordinator {
  private active?: Session;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly dependencies: { owner: GeneralGuardedState; protection: ProtectedStore; journal: GeneralSigningJournal;
    nonce: GeneralPendingNonceReader; funds: GeneralTransferFundsReader; simulation: GeneralTransferSimulationReader;
    approval: GeneralTransferApprovalOwner; fee: GeneralFeeQuoteReader; broadcast: GeneralRpcTransport;
    admission: () => SecretAdmission; authoritySignal: AbortSignal; now?: () => number; draft?: GeneralTransferDraftReader }) {}

  prepare(draft: Draft, parent?: AbortSignal) { return this.prepareOwned({ draft }, parent); }

  /** Protected input window only; the renderer cannot supply fees, balances, risks, identity or approval. */
  prepareInput(input: unknown, parent?: AbortSignal) { return this.prepareOwned({ input }, parent); }

  private async prepareOwned(request: { draft: Draft } | { input: unknown }, parent?: AbortSignal): Promise<{ token: object; preview: GeneralTransferPreview; feeQuote: GeneralFeeQuote;
    gasObservation: GeneralTransferGasObservation; confirmationExpiresAt: number }> {
    requireWallet(!this.dependencies.authoritySignal.aborted, "SECRET_ADMISSION_UNAVAILABLE", "Secret admission is unavailable.");
    requireWallet(!this.closed && !this.active && !parent?.aborted, "GENERAL_OPERATION_BUSY", "Manual transfer preparation is unavailable.");
    const controller = new AbortController(), token = Object.freeze({});
    const lifetime = parent ? AbortSignal.any([parent, this.dependencies.authoritySignal]) : this.dependencies.authoritySignal;
    const abort = () => { controller.abort(); this.dependencies.approval.invalidate();
      if (this.active?.token === token && this.active.phase === "prepared") void this.finish(this.active); };
    lifetime.addEventListener("abort", abort, { once: true });
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const session: Session = { token, controller, phase: "preparing", settled, resolveSettled,
      removeParent: () => lifetime.removeEventListener("abort", abort) };
    this.active = session;
    try {
      if (lifetime.aborted) abort();
      this.check(session);
      if ("input" in request) requireWallet(this.dependencies.draft instanceof GeneralTransferDraftReader,
        "GENERAL_DRAFT_UNAVAILABLE", "The protected manual input reader is unavailable.");
      const selectedInput = "input" in request ? this.dependencies.draft!.select(request.input) : undefined;
      let frozenDraft = "draft" in request ? structuredClone(request.draft) : undefined;
      const state = this.dependencies.owner.snapshot();
      const account = state.sources.find((item) => item.id === (selectedInput?.input.accountId ?? frozenDraft!.accountId) && item.status === "ready");
      requireWallet(account && state.setups.some((item) => item.id === account.setupId && item.phase === "ready"),
        "GENERAL_ACCOUNT_UNAVAILABLE", "A ready general wallet account is required.");
      session.owner = { ownerId: state.ownerId, installationId: state.installationId, sourceId: account.id,
        commitment: generalSourceCommitment(account) };
      const networkId = selectedInput?.input.networkId ?? frozenDraft!.networkId;
      await this.dependencies.journal.registerFreshStream(account.address, networkId);
      this.check(session);
      const pending = await this.dependencies.nonce.read(account.address, controller.signal);
      this.check(session);
      const reserved = await this.dependencies.journal.reserveNonce(account.address, networkId, pending.evidence);
      session.reservation = reserved.reservation; this.check(session);
      const initialQuote = selectedInput ? await this.dependencies.fee.read(controller.signal) : undefined;
      this.check(session);
      if (selectedInput) frozenDraft = await this.dependencies.draft!.read(selectedInput, { accountAddress: account.address,
        nonce: reserved.nonce, quote: initialQuote!, journal: this.dependencies.journal }, controller.signal, () => this.check(session));
      this.check(session);
      const preview = prepareGeneralTransfer({ ...frozenDraft!, ownerId: state.ownerId,
        accountAddress: account.address, nonce: reserved.nonce, now: this.now() });
      const quote = initialQuote ?? await this.dependencies.fee.read(controller.signal);
      this.check(session); bindGeneralFeeQuote(quote, preview, this.now());
      session.feeQuote = quote;
      session.feeTimer = setTimeout(() => { void this.cancel(); }, Math.max(1, quote.expiresAt - this.now()));
      session.feeTimer.unref();
      const [funds, preflight] = await Promise.all([
        this.dependencies.funds.read(preview, preview.digest, controller.signal),
        this.dependencies.simulation.read(preview, preview.digest, quote, controller.signal),
      ]);
      this.check(session); assertFreshGeneralPreparedPreview(preview, this.now());
      consumeGeneralTransferFunds(funds, preview.ownerId, transferRisk(preview, randomUUID()), this.now());
      const gasObservation = describeGeneralTransferSimulation(preflight, preview, quote, this.now());
      session.preflight = preflight;
      session.preview = preview; session.phase = "prepared";
      return { token, preview: structuredClone(preview), feeQuote: structuredClone(quote), gasObservation: structuredClone(gasObservation),
        confirmationExpiresAt: Math.min(preview.expiresAt, quote.expiresAt, gasObservation.expiresAt) };
    } catch (error) {
      await this.finish(session);
      throw this.sanitize(error);
    }
  }

  async execute(token: object): Promise<{ status: "SUBMITTED" | "UNKNOWN"; transactionHash: string }> {
    const session = this.active;
    requireWallet(session && session.token === token && session.phase === "prepared" && session.preview && session.reservation && session.feeQuote && session.preflight,
      "SIGNING_CONTINUITY_UNKNOWN", "The prepared transfer is unavailable.");
    session.phase = "executing";
    const preview = session.preview, reservation = session.reservation, signal = session.controller.signal, originalQuote = session.feeQuote;
    let riskPublicationAttempted = false, riskPublished = false;
    try {
      this.check(session); assertFreshGeneralPreparedPreview(preview, this.now());
      const approval = await this.untilCanceled(this.dependencies.approval.approve(preview, preview.digest, originalQuote, session.preflight), signal);
      this.check(session);
      const refreshedQuote = await this.dependencies.fee.read(signal);
      this.check(session); bindGeneralFeeQuote(refreshedQuote, preview, this.now());
      requireWallet(refreshedQuote.gasPriceAtomic === originalQuote.gasPriceAtomic &&
        refreshedQuote.baseFeePerGasAtomic === originalQuote.baseFeePerGasAtomic &&
        refreshedQuote.priorityFeePerGasAtomic === originalQuote.priorityFeePerGasAtomic,
      "GENERAL_FEE_CHANGED", "The observed fee changed and requires a new confirmation.");
      const [pending, funds, simulation] = await Promise.all([
        this.dependencies.nonce.read(preview.accountAddress, signal),
        this.dependencies.funds.read(preview, preview.digest, signal),
        this.dependencies.simulation.read(preview, preview.digest, refreshedQuote, signal),
      ]);
      this.check(session);
      const riskId = randomUUID(), risk = transferRisk(preview, riskId);
      const intent = await new GeneralTransferIntentStore(this.dependencies.protection).saveForJournal(preview, riskId, this.now());
      this.check(session);
      riskPublicationAttempted = true;
      const ticket = await this.dependencies.journal.recordSigningPossible(risk, reservation, pending.evidence, funds, approval, simulation, intent);
      riskPublished = true;
      this.check(session);
      const permit = await this.dependencies.journal.consumeSigningTicket(ticket, riskId, preview.digest);
      this.check(session);
      const signed = await signGeneralReadySource({ owner: this.dependencies.owner, protection: this.dependencies.protection,
        journal: this.dependencies.journal, material: new GeneralSignedMaterialStore(this.dependencies.protection),
        preview, riskId, permit, signal });
      this.check(session);
      return await broadcastGeneralTransfer(signed, signal, this.dependencies.broadcast);
    } catch (error) {
      if (riskPublished || riskPublicationAttempted && (signal.aborted || error instanceof WalletError && error.code === "GENERAL_OPERATION_CANCELED"))
        throw new WalletError("TRANSACTION_STATE_UNKNOWN", "The transfer state requires a signing-risk check before proceeding.");
      throw this.sanitize(error);
    }
    finally { await this.finish(session); }
  }

  async cancel(): Promise<void> {
    const session = this.active;
    if (!session) return;
    session.controller.abort(); this.dependencies.approval.invalidate();
    if (session.phase === "prepared") await this.finish(session);
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      const active = this.active;
      this.closing = (async () => {
        let failed = false;
        try { await this.cancel(); } catch { failed = true; }
        for (const dependency of [this.dependencies.nonce, this.dependencies.funds, this.dependencies.simulation,
          this.dependencies.approval, this.dependencies.fee, this.dependencies.draft]) {
          try { await dependency?.close(); } catch { failed = true; }
        }
        if (active) await active.settled;
        requireWallet(!failed, "GENERAL_OPERATION_FAILED", "The manual transfer owner could not be closed safely.");
      })();
    }
    return this.closing;
  }

  private now(): number { return this.dependencies.now?.() ?? Math.floor(performance.now()); }
  private check(session: Session): void {
    requireWallet(!this.closed && this.active === session && !session.controller.signal.aborted,
      "GENERAL_OPERATION_CANCELED", "The manual transfer was canceled.");
    let admitted = false;
    try { admitted = this.dependencies.admission() === "verified"; } catch { /* A missing authority is not admission. */ }
    requireWallet(admitted, "SECRET_ADMISSION_UNAVAILABLE", "Secret admission is unavailable.");
    if (session.owner) {
      const binding = session.owner;
      requireWallet(this.dependencies.owner.isLive(binding.ownerId, binding.installationId),
        "GENERAL_OPERATION_CANCELED", "The wallet owner is unavailable.");
      const state = this.dependencies.owner.snapshot(), source = state.sources.find((item) => item.id === binding.sourceId);
      requireWallet(source?.status === "ready" && generalSourceCommitment(source) === binding.commitment &&
        state.setups.some((item) => item.id === source.setupId && item.phase === "ready"),
      "GENERAL_ACCOUNT_UNAVAILABLE", "The general wallet account changed.");
    }
  }
  private finish(session: Session): Promise<void> {
    if (!session.finishing) session.finishing = (async () => {
      try {
        session.controller.abort(); this.dependencies.approval.invalidate();
        if (session.feeTimer) clearTimeout(session.feeTimer);
        if (session.reservation) await this.dependencies.journal.cancelUnsigned(session.reservation).catch(() => {});
        session.removeParent();
      } finally {
        if (this.active === session) this.active = undefined;
        session.resolveSettled();
      }
    })();
    return session.finishing;
  }
  private sanitize(error: unknown): WalletError {
    return error instanceof WalletError ? error : new WalletError("GENERAL_OPERATION_FAILED", "The manual transfer could not be completed.");
  }
  private async untilCanceled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    let onAbort = () => {};
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => { this.dependencies.approval.invalidate(); reject(new WalletError("GENERAL_OPERATION_CANCELED", "The manual transfer was canceled.")); };
      signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort();
    });
    try { return await Promise.race([work, stopped]); } finally { signal.removeEventListener("abort", onAbort); }
  }
}
