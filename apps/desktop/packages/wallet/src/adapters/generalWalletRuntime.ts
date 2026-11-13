import { prepareLocalGeneralPayment, signOwnedAllowance } from "./localGeneralPayment.js";
import type { GeneralExactPayment } from "./generalExactPayment.js";
import type { GeneralExactPaymentSession } from "./generalPaymentCustody.js";
import type { GeneralManagedKey } from "../app/ports.js";
import type { ProtectedStore } from "../app/ports.js";
import type { GeneralWalletState } from "../app/generalState.js";
import { GeneralGuardedState, type GeneralStateRepository } from "./generalGuardedState.js";
import { GeneralSetupCoordinator } from "./generalSetupCoordinator.js";
import { GeneralSigningJournal, type GeneralSigningJournalRepository } from "./generalSigningJournal.js";
import { GeneralManualTransferCoordinator } from "./generalManualTransferCoordinator.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { generalSourceCommitment } from "../app/generalState.js";
import { GeneralTransferHistoryReader, type GeneralHistoryQuery, type GeneralHistoryPage } from "./generalTransferHistory.js";
import { GeneralTransferRecoveryReader } from "./generalTransferRecovery.js";
import { GeneralTransferIntentStore } from "./generalTransferIntentStore.js";
import { GeneralSignedMaterialStore } from "./generalSignedMaterial.js";
import { GeneralSetupSession, type GeneralManualInputPort } from "./generalSetupSession.js";
import { GeneralBackupCoordinator, type GeneralBackupExportPorts } from "./generalBackupCoordinator.js";
import { GeneralBackupHistoryReader } from "./generalBackupHistory.js";
import type { GeneralBackupPayload } from "./generalBackupPayload.js";
import type { GeneralSnapshotLease } from "./generalSnapshotQueue.js";
import { GeneralRestorePublicationCoordinator, type GeneralRestorePublicationPorts, type GeneralRestoreBackupFile } from "./generalRestorePublication.js";
import { assertGeneralRestoreLocalState, type GeneralRestorePlan } from "./generalRestorePlan.js";
import { digest } from "./canonical.js";
import type { GeneralRestoreInput } from "./generalRestoreManagement.js";
import type { GeneralBackupInputPort } from "./generalBackupManagement.js";

type Inputs = {
  projection: GeneralStateRepository;
  protection: ProtectedStore;
  authority: ConstructorParameters<typeof GeneralSetupCoordinator>[2];
  /** The trusted caller must select create for a new owner and open-only for an existing owner. */
  journalRepository: () => GeneralSigningJournalRepository;
  isFreshSource: (address: string, networkId: string) => Promise<boolean>;
  /** Public identity frozen by the native initialization plan, never freshness or authentication authority. */
  initialSigningDomainId?: string;
  now?: () => number;
};

/** Internal isolated owner; constructing it does not establish trusted secret admission. */
export class GeneralWalletRuntime {
  private closing?: Promise<void>;
  private manual?: GeneralManualTransferCoordinator;
  private historyRead?: Promise<GeneralHistoryPage>;
  private protectedSession?: GeneralSetupSession;
  private backup?: GeneralBackupCoordinator;
  private restore?: GeneralRestorePublicationCoordinator;
  private backupFrozen = false;
  private readonly localPayments = new Set<GeneralExactPaymentSession>();
  private readonly localPreparing = new Set<Promise<unknown>>();
  private readonly usedAuthoritySignals = new WeakSet<AbortSignal>();
  private constructor(private readonly owner: GeneralGuardedState, private readonly protection: ProtectedStore,
    private readonly authority: Inputs["authority"], readonly setup: GeneralSetupCoordinator,
    readonly signingJournal: GeneralSigningJournal | null) {}

  static async create(input: Inputs, initial: GeneralWalletState): Promise<GeneralWalletRuntime> {
    // A surviving protected registry is evidence of a pre-existing domain, never a fresh install.
    try {
      const registry = await input.protection.get("general-signing-registry-v1");
      try { requireWallet(registry === null, "SIGNING_CONTINUITY_UNKNOWN", "A signing domain already exists or cannot be verified."); }
      finally { registry?.fill(0); }
    } catch {
      try { input.projection.close(); } catch { /* Keep the failed initialization closed. */ }
      throw new WalletError("SIGNING_CONTINUITY_UNKNOWN", "A signing domain already exists or cannot be verified.");
    }
    const owner = await GeneralGuardedState.initialize(input.projection, input.protection, initial);
    let journal: GeneralSigningJournal | null = null;
    try {
      const ticket = owner.issueFreshSigningDomainTicket(input.initialSigningDomainId);
      journal = await GeneralSigningJournal.initialize(input.journalRepository(), input.protection, initial.ownerId,
        ticket, input.isFreshSource, input.now);
    } catch { /* Keep the new signing capability unavailable; never recreate history on failure. */ }
    return new GeneralWalletRuntime(owner, input.protection, input.authority, new GeneralSetupCoordinator(owner, input.protection, input.authority), journal);
  }

  static async open(input: Inputs): Promise<GeneralWalletRuntime> {
    const owner = await GeneralGuardedState.open(input.projection, input.protection);
    let journal: GeneralSigningJournal | null = null;
    try {
      journal = await GeneralSigningJournal.open(input.journalRepository(), input.protection, owner, input.isFreshSource, input.now);
    } catch { /* Existing or missing history is not authority to initialize a new journal. */ }
    return new GeneralWalletRuntime(owner, input.protection, input.authority, new GeneralSetupCoordinator(owner, input.protection, input.authority), journal);
  }

  async signAllowance(...args: Parameters<NonNullable<import("../app/ports.js").KeyCustody["signAllowance"]>>) {
    requireWallet(!this.closing && this.authority.admission() === "local_system", "GENERAL_ACCOUNT_UNAVAILABLE", "The original local owner is unavailable.");
    const work = signOwnedAllowance(this.owner, this.protection, ...args);
    this.localPreparing.add(work);
    try { const raw = await work; requireWallet(!this.closing, "GENERAL_ACCOUNT_UNAVAILABLE", "The owner is closing."); return raw; }
    finally { this.localPreparing.delete(work); }
  }
  prepareLocalPayment(intent: GeneralExactPayment, signal?: AbortSignal): Promise<GeneralExactPaymentSession> {
    requireWallet(!this.closing && this.authority.admission() === "local_system", "GENERAL_ACCOUNT_UNAVAILABLE", "The original local owner is unavailable.");
    const work = (async () => {
      const session = await prepareLocalGeneralPayment(this.owner, this.protection, intent, signal);
      if (this.closing) { await session.close(); throw new WalletError("GENERAL_OPERATION_CANCELED", "The local owner is closing."); }
      this.localPayments.add(session); const close = session.close.bind(session);
      return { ...session, close: async () => { await close(); this.localPayments.delete(session); } };
    })();
    this.localPreparing.add(work);
    void work.finally(() => { this.localPreparing.delete(work); }).catch(() => {});
    return work;
  }
  /** Actual local owner projection for registration in the original payment ledger. */
  localPaymentSources(setupId?: string, paymentNetwork: import("../domain/model.js").Network = "eip155:84532"): GeneralManagedKey[] {
    requireWallet(!this.closing && this.authority.admission() === "local_system", "GENERAL_ACCOUNT_UNAVAILABLE", "The local source owner is unavailable.");
    const state = this.owner.snapshot();
    return state.sources.filter((source) => source.status === "ready" && (!setupId || source.setupId === setupId)).map((source) => ({ kind: "general_source",
      network: paymentNetwork, address: source.address, source: { protection: "local_system", installationId: state.installationId,
        enrollmentId: state.ownerId, profileId: state.ownerId, sourceId: source.id, sourceCommitment: generalSourceCommitment(source) } }));
  }
  /** Local trusted host only; this is not an SDK, MCP or Skill operation. */
  openProtectedSession(isCurrent: () => boolean, manual?: {
    dependencies(networkId: string): Parameters<GeneralWalletRuntime["openManualTransfer"]>[0];
    assets?: GeneralManualInputPort["assets"];
  }, backup?: GeneralBackupExportPorts, restore?: GeneralRestoreInput): GeneralSetupSession {
    requireWallet(!this.closing && !this.protectedSession, "GENERAL_OPERATION_BUSY", "The protected management owner is unavailable.");
    this.protectedSession = new GeneralSetupSession(this.setup, { isCurrent: () => !this.closing && isCurrent() === true, closeOwner: () => this.close() },
      { read: (input) => this.readTransferHistory(input) }, manual && this.signingJournal ? {
        ...(manual.assets ? { assets: manual.assets.bind(manual) } : {}),
        send: async (input, signal) => {
          requireWallet(!signal.aborted && isCurrent() === true, "GENERAL_OPERATION_CANCELED", "The manual input window is unavailable.");
          const coordinator = this.openManualTransfer(manual.dependencies(input.networkId));
          try {
            const prepared = await coordinator.prepareInput(input, signal);
            return await coordinator.execute(prepared.token);
          } finally { await this.closeManualTransfer(coordinator); }
        },
      } : undefined, backup && this.signingJournal ? this.backupManagementInput(isCurrent, backup) : undefined, restore);
    return this.protectedSession;
  }

  private backupManagementInput(isCurrent: () => boolean, ports: GeneralBackupExportPorts): GeneralBackupInputPort {
    const current = () => requireWallet(!this.closing && isCurrent() === true && this.authority.admission() === "verified",
      "SECRET_ADMISSION_UNAVAILABLE", "The original protected backup window is unavailable.");
    return {
      options: () => {
        current(); const state = this.owner.snapshot();
        return { sourceCommitment: digest(state), sources: state.sources.map((source) => ({ sourceId: source.id, address: source.address,
          sourceType: source.sourceType, status: source.status, backupVerified: source.backupVerified })),
          pendingSetups: state.setups.filter((setup) => setup.pendingKeyRef && !state.sources.some((source) => source.setupId === setup.id))
            .map((setup) => ({ setupId: setup.id, mode: setup.mode, phase: setup.phase as "started" | "secret_staged" | "backup_pending" | "canceled", createdAt: setup.createdAt })) };
      },
      send: async (selection, password, expectedCommitment, signal) => {
        current(); requireWallet(!signal.aborted, "GENERAL_OPERATION_CANCELED", "The original backup input was canceled.");
        requireWallet(digest(this.owner.snapshot()) === expectedCommitment, "GENERAL_BACKUP_HISTORY_CHANGED", "The original backup choices changed.");
        const result = await this.exportBackup(selection, password, ports, signal);
        return { backupId: result.backupId, sourceKeyCount: result.sourceKeyCount, pendingKeyCount: result.pendingKeyCount, allReferencedKeys: result.allReferencedKeys };
      },
    };
  }

  /** Local trusted host only; this is not an SDK, MCP or Skill operation. */
  openManualTransfer(dependencies: Omit<ConstructorParameters<typeof GeneralManualTransferCoordinator>[0], "owner" | "protection" | "journal" | "admission">): GeneralManualTransferCoordinator {
    requireWallet(!this.backupFrozen, "GENERAL_OPERATION_BUSY", "A general wallet backup snapshot is active.");
    requireWallet(!this.closing && this.signingJournal, "SIGNING_CONTINUITY_UNKNOWN", "Manual signing is unavailable.");
    requireWallet(!this.manual, "GENERAL_OPERATION_BUSY", "A manual transfer owner is already active.");
    requireWallet(dependencies.authoritySignal instanceof AbortSignal && !dependencies.authoritySignal.aborted &&
      !this.usedAuthoritySignals.has(dependencies.authoritySignal), "SECRET_ADMISSION_UNAVAILABLE", "A fresh authority lifetime is required.");
    this.usedAuthoritySignals.add(dependencies.authoritySignal);
    this.manual = new GeneralManualTransferCoordinator({ ...dependencies, owner: this.owner,
      protection: this.protection, journal: this.signingJournal, admission: () => this.authority.admission() });
    return this.manual;
  }

  async closeManualTransfer(manual: GeneralManualTransferCoordinator): Promise<void> {
    requireWallet(this.manual === manual, "GENERAL_OPERATION_CANCELED", "The manual transfer owner is unavailable.");
    await manual.close();
    if (this.manual === manual) this.manual = undefined;
  }

  /** Protected host only. No ordinary asset, Skill, SDK or MCP entry exposes this transaction or its ports. */
  exportBackup(selection: GeneralBackupPayload["keyCoverage"], password: string, ports: GeneralBackupExportPorts, signal?: AbortSignal): ReturnType<GeneralBackupCoordinator["export"]> {
    requireWallet(!this.closing && this.signingJournal, "GENERAL_BACKUP_UNAVAILABLE", "The protected backup owner is unavailable.");
    this.backup ??= new GeneralBackupCoordinator({ owner: this.owner, protection: this.protection,
      history: new GeneralBackupHistoryReader(this.owner, this.signingJournal, new GeneralTransferIntentStore(this.protection)),
      reserve: () => this.reserveBackupSnapshot(), admission: () => !this.closing && this.authority.admission() === "verified" });
    return this.backup.export(selection, password, ports, signal);
  }

  /** Same-installation protected recovery only; native publication never changes a Skill wallet. */
  publishRestoredTarget(plan: GeneralRestorePlan, ports: GeneralRestorePublicationPorts, signal?: AbortSignal): ReturnType<GeneralRestorePublicationCoordinator["publish"]> {
    return this.restorePublication(plan).publish(plan, ports, signal);
  }

  /** Same private owner and lease as continuation, including authenticated material staging from the original backup. */
  restoreEncryptedBackup(plan: GeneralRestorePlan, file: GeneralRestoreBackupFile, ports: GeneralRestorePublicationPorts,
    signal?: AbortSignal): ReturnType<GeneralRestorePublicationCoordinator["restore"]> {
    return this.restorePublication(plan).restore(plan, file, ports, signal);
  }

  private restorePublication(plan: GeneralRestorePlan): GeneralRestorePublicationCoordinator {
    requireWallet(!this.closing && this.signingJournal && plan.mode === "same_installation",
      "GENERAL_RECOVERY_STORE_UNAVAILABLE", "The existing protected restore owner is unavailable.");
    this.restore ??= new GeneralRestorePublicationCoordinator({ admission: () => !this.closing && this.authority.admission() === "verified",
      reserve: (current) => {
        const lease = this.reserveBackupSnapshot();
        try {
          const state = this.owner.snapshot();
          requireWallet(current.target.ownerId === state.ownerId && current.target.installationId === state.installationId,
            "GENERAL_RECOVERY_RECORD_CONFLICT", "The restore target belongs to another wallet owner.");
          if (current.phase !== "binding_published" && current.phase !== "reopened") assertGeneralRestoreLocalState(current, state);
          return lease;
        } catch (error) { lease.release(); throw error; }
      } });
    return this.restore;
  }

  private reserveBackupSnapshot(): GeneralSnapshotLease {
    requireWallet(!this.closing && !this.manual && !this.historyRead && !this.backupFrozen && this.signingJournal,
      "GENERAL_OPERATION_BUSY", "The general wallet owner is busy.");
    const resumeSetup = this.setup.pauseForBackup();
    let state: GeneralSnapshotLease | undefined, journal: GeneralSnapshotLease | undefined;
    try { state = this.owner.reserveBackupSnapshot(); journal = this.signingJournal.reserveBackupSnapshot(); this.backupFrozen = true; }
    catch (error) { journal?.release(); state?.release(); resumeSetup(); throw error; }
    let released = false;
    return { isCurrent: () => !released && !this.closing && state!.isCurrent() && journal!.isCurrent(),
      release: () => { if (!released) { released = true; journal!.release(); state!.release(); resumeSetup(); this.backupFrozen = false; } } };
  }

  /** Private local history; the caller selects this owner's source, never supplies an arbitrary account address. */
  async readTransferHistory(input: GeneralHistoryQuery): Promise<GeneralHistoryPage> {
    requireWallet(!this.closing && !this.historyRead, "GENERAL_OPERATION_BUSY", "Transfer history is unavailable or busy.");
    requireWallet(this.signingJournal, "GENERAL_HISTORY_UNAVAILABLE", "The signing history is unavailable.");
    const frozen = structuredClone(input), state = this.owner.snapshot(), source = state.sources.find((entry) => entry.id === frozen.sourceId);
    requireWallet(source, "GENERAL_ACCOUNT_UNAVAILABLE", "The general wallet account is unavailable.");
    const commitment = generalSourceCommitment(source);
    const current = () => {
      requireWallet(!this.closing && this.owner.isLive(state.ownerId, state.installationId), "GENERAL_OPERATION_CANCELED", "The history owner is unavailable.");
      const latest = this.owner.snapshot().sources.find((entry) => entry.id === source.id);
      requireWallet(latest && generalSourceCommitment(latest) === commitment, "GENERAL_ACCOUNT_UNAVAILABLE", "The history account changed.");
    };
    const recovery = new GeneralTransferRecoveryReader(this.owner, this.signingJournal, new GeneralTransferIntentStore(this.protection), new GeneralSignedMaterialStore(this.protection), current);
    const pending = new GeneralTransferHistoryReader(this.signingJournal, recovery).read(frozen, source.address, current);
    this.historyRead = pending;
    try { return await pending; } finally { if (this.historyRead === pending) this.historyRead = undefined; }
  }

  close(): Promise<void> {
    if (!this.closing) {
      let resolve!: () => void, reject!: (error: unknown) => void;
      this.closing = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
      const participants = Promise.allSettled([this.setup.close(), this.manual?.close(), this.historyRead?.catch(() => {})]);
      const snapshots = Promise.allSettled([this.backup?.close(), this.restore?.close(), this.protectedSession?.drainRestore()]);
      void (async () => {
        await Promise.allSettled(this.localPreparing);
        await Promise.all([...this.localPayments].map((payment) => payment.close()));
        // Uncertain native drain retains the new domain instead of releasing its state/journal underneath it.
        const drains = await snapshots;
        const unsafe = drains.find((result) => result.status === "rejected");
        if (unsafe?.status === "rejected") throw unsafe.reason;
        const results = await participants;
        try { await this.signingJournal?.close(); } finally { await this.owner.close(); }
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })().then(resolve, reject);
    }
    return this.closing;
  }
}
