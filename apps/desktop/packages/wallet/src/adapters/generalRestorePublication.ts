import { z } from "zod";
import type { GeneralSnapshotLease } from "./generalSnapshotQueue.js";
import { canonical, digest } from "./canonical.js";
import { GeneralRecoveryRecordSession } from "./generalRecoveryRecordSession.js";
import { GeneralRestoreStateStage } from "./generalRestoreStateStage.js";
import { validateGeneralAssignment, type GeneralAssignment } from "./generalInitializationRecord.js";
import { assertGeneralRestoreDomainBinding, validateGeneralDomainBinding, type GeneralDomainBinding } from "./generalDomainBinding.js";
import { validateGeneralRestorePlan, type GeneralRestorePlan } from "./generalRestorePlan.js";
import { generalRecoveryId, generalRecoveryHash } from "./generalRecoveryRecord.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import type { GeneralRestoreKeyAdmission } from "./generalRestoreKeyStage.js";
import { assertGeneralBackupJobInput } from "./generalBackupEnvelope.js";
import { validateGeneralHistoryArchiveEncrypted, type GeneralHistoryArchiveEncrypted } from "./generalHistoryArchiveEnvelope.js";

const archivesSchema = z.array(z.strictObject({ artifactId: generalRecoveryId, archiveCiphertextDigest: generalRecoveryHash })).max(8);
type Archive = z.infer<typeof archivesSchema>[number];
export type GeneralRestoreBackupFile = { backup: string; password: string };
export type GeneralRestorePublicationScope = {
  records: GeneralRecoveryRecordSession;
  state: GeneralRestoreStateStage;
  assignment: GeneralAssignment;
  keyAdmission?: GeneralRestoreKeyAdmission;
  isCurrent(): boolean;
  close(): Promise<void>;
  /** Must authenticate AEAD, the original plan and durable file IO before reporting each artifact. */
  verifiedArchives(plan: GeneralRestorePlan, signal: AbortSignal): Promise<Archive[]>;
  prepareArchive(plan: GeneralRestorePlan, signal: AbortSignal, candidate?: Readonly<GeneralHistoryArchiveEncrypted>): Promise<void>;
  /** Same-installation live history only; preserves the latest local intent, signature and broadcast facts. */
  prepareLiveHistory(plan: GeneralRestorePlan, signal: AbortSignal): Promise<void>;
  verifyTarget(plan: GeneralRestorePlan, binding: GeneralDomainBinding, signal: AbortSignal): Promise<void>;
  /** Open-only; reopened plans allow verified later state advances, never a frozen-state rewrite. */
  openTarget(plan: GeneralRestorePlan, binding: GeneralDomainBinding, signal: AbortSignal): Promise<void>;
};
export type GeneralRestorePublicationPorts = { authorize(plan: GeneralRestorePlan, signal: AbortSignal): Promise<GeneralRestorePublicationScope> };
type Owner = { admission(): boolean; reserve(plan: GeneralRestorePlan): GeneralSnapshotLease };
export type GeneralRestorePublicationResult = { recoveryId: string; planDigest: string; profileId: string; bindingDigest: string;
  signingMode: "live" | "archive_only"; phase: "reopened" };
export class GeneralRestorePublicationUncertain extends WalletError {
  constructor(readonly recoveryId: string, readonly planDigest: string, readonly step: string, readonly artifactId?: string) {
    super("GENERAL_RECOVERY_WRITE_UNCERTAIN", "The original restore publication requires inspection before another attempt.");
  }
}
function freeze<T>(input: T): T {
  if (input && typeof input === "object") { Object.values(input).forEach(freeze); Object.freeze(input); }
  return input;
}
function candidate(plan: GeneralRestorePlan, assignment: GeneralAssignment, previous: GeneralDomainBinding | null, archive: Archive): GeneralDomainBinding {
  const body = { format: "koincode-general-domain-binding" as const, version: 1 as const, uid: assignment.uid,
    ownerId: plan.target.ownerId, installationId: plan.target.installationId, enrollmentId: plan.enrollmentId,
    revision: previous ? previous.revision + 1 : 1, profileId: plan.target.profileId,
    origin: { kind: "restore" as const, recoveryId: plan.recoveryId, planDigest: plan.planDigest, archiveDigest: plan.target.archiveDigest, ...archive },
    signing: plan.target.signingContinuity === "complete" && previous?.signing.mode === "live" ?
      { mode: "live" as const, domainId: previous.signing.domainId } : { mode: "archive_only" as const, domainId: null },
    previousBindingDigest: plan.target.previousBindingDigest };
  const result = validateGeneralDomainBinding({ ...body, bindingDigest: digest(body) });
  assertGeneralRestoreDomainBinding(result, assignment, plan, previous); return result;
}

/** A child of the sole protected runtime/enrollment owner, not a second source or native authority. */
export class GeneralRestorePublicationCoordinator {
  private active?: { controller: AbortController; done: Promise<void> };
  private closed = false;
  private uncertain?: GeneralRestorePublicationUncertain;
  private closeFailure?: WalletError;
  constructor(private readonly owner: Owner, private readonly maximumMs = 180000) {
    requireWallet(Number.isSafeInteger(maximumMs) && maximumMs > 0 && maximumMs <= 180000,
      "GENERAL_RECOVERY_RECORD_INVALID", "The restore publication deadline is invalid.");
  }

  publish(input: GeneralRestorePlan, ports: GeneralRestorePublicationPorts, parent?: AbortSignal): Promise<GeneralRestorePublicationResult> {
    return this.run(input, ports, parent);
  }

  /** The private restore window owns the caller's file/password; no secret is passed to authorization or returned. */
  async restore(input: GeneralRestorePlan, file: GeneralRestoreBackupFile, ports: GeneralRestorePublicationPorts,
    parent?: AbortSignal): Promise<GeneralRestorePublicationResult> {
    const owned = { backup: file.backup, password: file.password };
    try {
      assertGeneralBackupJobInput({ operation: "decrypt_backup", ...owned });
      return await this.run(input, ports, parent, owned);
    } finally { owned.backup = ""; owned.password = ""; }
  }

  private async run(input: GeneralRestorePlan, ports: GeneralRestorePublicationPorts, parent?: AbortSignal,
    file?: GeneralRestoreBackupFile): Promise<GeneralRestorePublicationResult> {
    if (this.uncertain) throw this.uncertain;
    requireWallet(!this.closed && !this.active, "GENERAL_OPERATION_BUSY", "A restore publication is already running.");
    const original = freeze(validateGeneralRestorePlan(input)), controller = new AbortController();
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    let finish!: () => void; const done = new Promise<void>((resolve) => { finish = resolve; });
    const operation = { controller, done }; this.active = operation;
    const timer = setTimeout(() => controller.abort(), this.maximumMs); timer.unref();
    let lastTime = performance.now(); const expiresAt = lastTime + this.maximumMs;
    const checkTime = () => {
      const now = performance.now();
      if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || now < lastTime || now >= expiresAt) controller.abort();
      lastTime = now;
    };
    let scope: GeneralRestorePublicationScope | undefined, lease: GeneralSnapshotLease | undefined, publicationPossible = false;
    let materialsVerified = file === undefined;
    let preparedArchive: GeneralHistoryArchiveEncrypted | undefined;
    let nativeClose: (() => Promise<void>) | undefined, authorizationReturned = false;
    const current = () => {
      checkTime();
      requireWallet(!this.closed && !signal.aborted, "GENERAL_RECOVERY_OPERATION_CANCELED", "The restore publication was canceled.");
      requireWallet((publicationPossible || this.owner.admission() === true) && (!scope || scope.isCurrent() === true) &&
        (publicationPossible || !lease || lease.isCurrent()), "GENERAL_RECOVERY_STORE_UNAVAILABLE", "The protected restore operation is unavailable.");
    };
    const effect = async (step: string, action: () => Promise<void>) => {
      current();
      try { const result: unknown = await action(); if (result !== undefined) throw new Error("Invalid private restore completion."); }
      catch { this.uncertain = new GeneralRestorePublicationUncertain(original.recoveryId, original.planDigest, step,
        step === "archive" ? preparedArchive?.artifactId : undefined); throw this.uncertain; }
      current();
    };
    const readPlan = async () => {
      current(); const value = await scope!.records.readRestore(original.recoveryId, signal); current();
      requireWallet(value && canonical({ ...value, phase: original.phase }) === canonical(original) && (value.phase !== "prepared" || !materialsVerified),
        "GENERAL_RECOVERY_RECORD_CONFLICT", "The same keys-staged restore plan is required.");
      return freeze(value);
    };
    const archives = async (plan: GeneralRestorePlan) => {
      current(); const result = archivesSchema.parse(await scope!.verifiedArchives(freeze(structuredClone(plan)), signal)); current();
      requireWallet(new Set(result.map((entry) => entry.artifactId)).size === result.length,
        "GENERAL_RECOVERY_RECORD_CONFLICT", "The verified archive inventory is ambiguous.");
      return result.sort((a, b) => a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0);
    };
    const run = async (): Promise<GeneralRestorePublicationResult> => {
      current(); const authorized = await ports.authorize(original, signal); authorizationReturned = true;
      if (authorized && typeof authorized.close === "function") nativeClose = authorized.close.bind(authorized);
      requireWallet(authorized && nativeClose && authorized.records instanceof GeneralRecoveryRecordSession &&
        authorized.state instanceof GeneralRestoreStateStage && ["isCurrent", "verifiedArchives", "prepareArchive", "prepareLiveHistory", "verifyTarget", "openTarget"]
          .every((key) => typeof authorized[key as keyof GeneralRestorePublicationScope] === "function"),
      "GENERAL_RECOVERY_STORE_UNAVAILABLE", "The native restore publication scope is unavailable.");
      scope = authorized; const assignment = freeze(validateGeneralAssignment(scope.assignment)); current();
      requireWallet(assignment.ownerId === original.target.ownerId && assignment.installationId === original.target.installationId &&
        assignment.enrollmentId === original.enrollmentId, "GENERAL_RECOVERY_RECORD_CONFLICT", "The native assignment does not match this restore target.");
      let plan = await readPlan();
      lease = this.owner.reserve(plan); current(); plan = await readPlan();
      let fixed = await scope.records.readRestoreBinding(plan.recoveryId, signal);
      let active = await scope.records.readActiveBinding(signal); current();
      requireWallet(plan.phase !== "prepared" && plan.phase !== "keys_staged" || fixed === null,
        "GENERAL_RECOVERY_RECORD_CONFLICT", "A restore candidate cannot precede its staged projection.");
      let previous: GeneralDomainBinding | null = null;
      if (plan.target.previousBindingDigest) {
        previous = await scope.records.readHistoricalBinding(plan.target.previousBindingDigest, signal); current();
        if (!previous && active?.bindingDigest === plan.target.previousBindingDigest) previous = active;
        requireWallet(previous && ["uid", "ownerId", "installationId", "enrollmentId"].every((key) =>
          previous![key as keyof GeneralDomainBinding] === assignment[key as keyof GeneralAssignment]) && previous.revision < Number.MAX_SAFE_INTEGER &&
          (plan.target.signingContinuity !== "complete" || previous.signing.mode === "live"),
        "GENERAL_RECOVERY_RECORD_CONFLICT", "The original predecessor is unavailable.");
      }
      if (fixed) assertGeneralRestoreDomainBinding(fixed, assignment, plan, previous);
      const originalActive = active?.bindingDigest === plan.target.previousBindingDigest || active === null && plan.target.previousBindingDigest === null;
      requireWallet(originalActive || fixed && active?.bindingDigest === fixed.bindingDigest,
        "GENERAL_RECOVERY_RECORD_CONFLICT", "The active profile is not the original restore predecessor or candidate.");
      if (file) {
        requireWallet(typeof scope.keyAdmission?.admitKey === "function", "GENERAL_RECOVERY_STORE_UNAVAILABLE", "The native restore material port is unavailable.");
        current();
        try {
          const staged = await scope.records.stageRestoreKeysWithArchive(plan, file, scope.keyAdmission, signal);
          plan = freeze(staged.plan); preparedArchive = staged.archive ?? undefined; materialsVerified = true;
        }
        catch (error) {
          if (error instanceof WalletError && error.code === "GENERAL_RECOVERY_WRITE_UNCERTAIN") {
            this.uncertain = new GeneralRestorePublicationUncertain(original.recoveryId, original.planDigest, "keys"); throw this.uncertain;
          }
          throw error;
        } finally { file.backup = ""; file.password = ""; }
        current();
      }
      if (plan.phase === "keys_staged") {
        await effect("state", () => scope!.state.stage(signal));
        let publishedArchive: Readonly<GeneralHistoryArchiveEncrypted> | undefined;
        if ((await archives(plan)).length === 0) {
          publishedArchive = preparedArchive ? Object.freeze(validateGeneralHistoryArchiveEncrypted(preparedArchive, plan, preparedArchive.artifactId)) : undefined;
          await effect("archive", () => scope!.prepareArchive(plan, signal, publishedArchive));
        } else if (preparedArchive) { preparedArchive.archive = ""; preparedArchive = undefined; }
        if (plan.target.signingContinuity === "complete") await effect("live_history", () => scope!.prepareLiveHistory(plan, signal));
        const inventory = await archives(plan);
        requireWallet(inventory.length > 0, "GENERAL_RECOVERY_RECORD_CONFLICT", "The original staged archive is unavailable.");
        requireWallet(!publishedArchive || inventory.some((entry) => entry.artifactId === publishedArchive.artifactId &&
          entry.archiveCiphertextDigest === publishedArchive.archiveCiphertextDigest),
        "GENERAL_RECOVERY_RECORD_CONFLICT", "The prepared archive was not verified at its original reference.");
        const next = candidate(plan, assignment, previous, inventory[0]!);
        current(); const checked: unknown = await scope.verifyTarget(plan, freeze(next), signal); current();
        requireWallet(checked === undefined, "GENERAL_RECOVERY_RECORD_INVALID", "The native target verification was invalid.");
        await effect("projection_phase", async () => { plan = await scope!.records.advanceRestore(plan, { ...plan, phase: "projection_staged" }, signal); });
      }
      plan = await readPlan();
      if (plan.phase === "projection_staged") {
        await scope.state.inspect(signal); current();
        const inventory = await archives(plan);
        if (!fixed) { requireWallet(inventory.length > 0, "GENERAL_RECOVERY_RECORD_CONFLICT", "The staged archive is missing.");
          fixed = candidate(plan, assignment, previous, inventory[0]!); }
        const origin = fixed.origin;
        requireWallet(origin.kind === "restore" && inventory.some((entry) => entry.artifactId === origin.artifactId &&
          entry.archiveCiphertextDigest === origin.archiveCiphertextDigest), "GENERAL_RECOVERY_RECORD_CONFLICT", "The fixed restore archive is missing or changed.");
        current(); const verified: unknown = await scope.verifyTarget(plan, freeze(structuredClone(fixed)), signal); current();
        requireWallet(verified === undefined, "GENERAL_RECOVERY_RECORD_INVALID", "The native target verification was invalid.");
        if (previous) await effect("predecessor", async () => { await scope!.records.prepareHistoricalBinding(previous!, signal); });
        await effect("candidate", async () => { fixed = await scope!.records.prepareRestoreBinding(plan, fixed!, previous, signal); });
        await effect("candidate_history", async () => { await scope!.records.prepareHistoricalBinding(fixed!, signal); });
        current(); publicationPossible = true;
        await effect("binding", async () => { await scope!.records.publishRestoreBinding(plan, fixed!, previous, signal); });
        await effect("binding_phase", async () => { plan = await scope!.records.advanceRestore(plan, { ...plan, phase: "binding_published" }, signal); });
      }
      plan = await readPlan();
      requireWallet(fixed, "GENERAL_RECOVERY_RECORD_CONFLICT", "The original fixed restore candidate is missing.");
      assertGeneralRestoreDomainBinding(fixed, assignment, plan, previous);
      active = await scope.records.readActiveBinding(signal); current();
      requireWallet(active && canonical(active) === canonical(fixed), "GENERAL_RECOVERY_RECORD_CONFLICT", "The original restore target is not active.");
      publicationPossible = true;
      if (plan.phase === "binding_published") { await scope.state.inspect(signal); current(); }
      const verified: unknown = await scope.verifyTarget(plan, freeze(structuredClone(fixed)), signal); current();
      requireWallet(verified === undefined, "GENERAL_RECOVERY_RECORD_INVALID", "The native target verification was invalid.");
      await effect("reopen", () => scope!.openTarget(plan, freeze(structuredClone(fixed!)), signal));
      if (plan.phase === "binding_published")
        await effect("reopened_phase", async () => { plan = await scope!.records.advanceRestore(plan, { ...plan, phase: "reopened" }, signal); });
      plan = await readPlan();
      requireWallet(plan.phase === "reopened", "GENERAL_RECOVERY_RECORD_CONFLICT", "The restore target did not reopen.");
      return { recoveryId: plan.recoveryId, planDigest: plan.planDigest, profileId: plan.target.profileId,
        bindingDigest: fixed.bindingDigest, signingMode: fixed.signing.mode, phase: "reopened" };
    };
    let result: GeneralRestorePublicationResult | undefined, failure: unknown;
    try { result = await run(); }
    catch (error) { failure = error instanceof GeneralRestorePublicationUncertain ? error : new WalletError(error instanceof WalletError ? error.code :
      "GENERAL_RECOVERY_STORE_UNAVAILABLE", "The original protected restore publication could not be completed."); }
    try {
      if (authorizationReturned && !nativeClose) throw new Error("The native restore scope cannot be drained.");
      const closed: unknown = await nativeClose?.();
      if (closed !== undefined) throw new Error("Invalid native restore drain completion.");
      lease?.release(); if (this.active === operation) this.active = undefined;
    }
    catch {
      this.closed = true; this.closeFailure = new WalletError("GENERAL_RECOVERY_STORE_UNAVAILABLE", "The native restore operation did not drain safely.");
      failure = this.uncertain ?? this.closeFailure;
    } finally { clearTimeout(timer); if (preparedArchive) preparedArchive.archive = ""; finish(); }
    checkTime();
    if (!failure && (this.closed || signal.aborted)) failure = new WalletError("GENERAL_RECOVERY_OPERATION_CANCELED", "The completed restore operation was canceled before delivery.");
    if (failure) throw failure;
    return result!;
  }
  close(): Promise<void> {
    this.closed = true; this.active?.controller.abort();
    return (this.active?.done ?? Promise.resolve()).then(() => { if (this.closeFailure) throw this.closeFailure; });
  }
}
