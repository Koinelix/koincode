import { createHash, randomUUID } from "node:crypto";
import type { ProtectedStore } from "../app/ports.js";
import { GENERAL_SIGNING_POLICY_DIGEST, GENERAL_SIGNING_POLICY_VERSION } from "../domain/generalSigningPolicy.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { digest } from "./canonical.js";
import type { GeneralGuardedState } from "./generalGuardedState.js";
import type { GeneralBackupHistoryReader } from "./generalBackupHistory.js";
import type { GeneralSnapshotLease } from "./generalSnapshotQueue.js";
import { generalBackupSelection, validateGeneralBackupPayload, type GeneralBackupPayload } from "./generalBackupPayload.js";
import { generalBackupPassword, inspectGeneralBackupEnvelope } from "./generalBackupEnvelope.js";
import { runGeneralBackupTask } from "./generalCryptoTask.js";
import type { GeneralBackupEncrypted, GeneralBackupJob } from "./generalBackupCrypto.js";

type Selection = GeneralBackupPayload["keyCoverage"];
type Capture = { state: ReturnType<GeneralGuardedState["snapshot"]>; history: Awaited<ReturnType<GeneralBackupHistoryReader["capture"]>> };
type Frozen = { backupId: string; createdAt: number | null; ownerId: string; installationId: string; sourceRevision: number;
  sourceCommitment: string; historyDigest: string; keyCoverage: Selection; historyCoverage: GeneralBackupPayload["historyCoverage"];
  signingCoverage: GeneralBackupPayload["signingCoverage"]; keyRefs: string[] };
export type GeneralBackupExportPlan = Frozen & { planDigest: string };
export type GeneralBackupPublication = { reference: object; ciphertextDigest: string; byteLength: number };
export class GeneralBackupExportUncertain extends WalletError {
  constructor(readonly reference: object) { super("GENERAL_BACKUP_EXPORT_UNCERTAIN", "The backup publication requires checking its original target."); }
}
type PublicationMetadata = { backupId: string; ciphertextDigest: string; byteLength: number };
export type GeneralBackupExportPorts = {
  /** Native adapter owns the exact live operation scope; this result is not itself key-release authority. */
  authorize(plan: GeneralBackupExportPlan, signal: AbortSignal): Promise<{ isCurrent(): boolean; close(): Promise<void> }>;
  selectTarget(metadata: PublicationMetadata, signal: AbortSignal): Promise<object>;
  /** Must consume the exact opaque target once and return only after durable verified completion. */
  publish(target: object, backup: string, metadata: PublicationMetadata,
    current: () => void, signal: AbortSignal): Promise<GeneralBackupPublication>;
};
type OwnerPorts = { owner: GeneralGuardedState; history: GeneralBackupHistoryReader; protection: ProtectedStore;
  reserve(): GeneralSnapshotLease; admission(): boolean };
type ExportResult = { backupId: string; payloadDigest: string; sourceKeyCount: number; pendingKeyCount: number;
  allReferencedKeys: boolean; publication: GeneralBackupPublication };

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function frozenPlan(capture: Capture, selection: Selection, backupId: string, createdAt: number | null): GeneralBackupExportPlan {
  const { state, history } = capture, selected = generalBackupSelection(state, selection);
  const { ownerId, installationId, sourceRevision, sourceCommitment } = history;
  const body: Frozen = { backupId, createdAt, ownerId, installationId, sourceRevision, sourceCommitment, historyDigest: digest(history),
    keyCoverage: selected.coverage, keyRefs: selected.keyRefs,
    historyCoverage: { kind: "whole_domain", accountAddresses: [...new Set([...state.sources.map((source) => source.address),
      ...history.signing.streams.map((stream) => stream.accountAddress)])].sort(), networkIds: [...new Set(history.signing.streams.map((stream) => stream.networkId))].sort() },
    signingCoverage: history.signing.streams.map(({ events: _events, ...metadata }) => metadata).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
  requireWallet(state.ownerId === ownerId && state.installationId === installationId && state.revision === sourceRevision &&
    digest(state) === sourceCommitment, "GENERAL_BACKUP_HISTORY_CHANGED", "The wallet changed during backup preparation.");
  return freeze({ ...body, planDigest: digest(body) });
}

/** One private runtime transaction. Native admission and durable file publication must be supplied independently. */
export class GeneralBackupCoordinator {
  private active?: { controller: AbortController; done: Promise<void> };
  private closed = false;
  private closeFailure?: WalletError;
  private uncertain?: GeneralBackupExportUncertain;
  constructor(private readonly owner: OwnerPorts,
    private readonly crypto: (job: GeneralBackupJob, signal: AbortSignal) => Promise<GeneralBackupEncrypted> = runGeneralBackupTask,
    private readonly maximumMs = 180000) {
    requireWallet(Number.isSafeInteger(maximumMs) && maximumMs > 0 && maximumMs <= 180000,
      "GENERAL_BACKUP_INVALID", "The backup operation deadline is invalid.");
  }

  async export(selection: Selection, password: string, ports: GeneralBackupExportPorts, parent?: AbortSignal): Promise<ExportResult> {
    if (this.uncertain) throw this.uncertain;
    requireWallet(!this.closed && !this.active, "GENERAL_OPERATION_BUSY", "A general wallet backup operation is already running.");
    const checkedPassword = generalBackupPassword(password); checkedPassword.fill(0);
    const controller = new AbortController();
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    let finish!: () => void; const done = new Promise<void>((resolve) => { finish = resolve; });
    const operation = { controller, done }; this.active = operation;
    const timer = setTimeout(() => controller.abort(), this.maximumMs); timer.unref();
    let authorization: Awaited<ReturnType<GeneralBackupExportPorts["authorize"]>> | undefined, lease: GeneralSnapshotLease | undefined;
    const wrappingKeys: GeneralBackupPayload["wrappingKeys"] = [];
    let publicationStarted = false;
    let target: object | undefined;
    const current = () => {
      requireWallet(!this.closed && !signal.aborted, "GENERAL_OPERATION_CANCELED", "The backup operation was canceled.");
      requireWallet(this.owner.admission() === true && (!authorization || authorization.isCurrent() === true) && (!lease || lease.isCurrent()),
        "SECRET_ADMISSION_UNAVAILABLE", "The protected backup operation is unavailable.");
    };
    const capture = async (): Promise<Capture> => {
      current(); const state = this.owner.owner.snapshot(), history = await this.owner.history.capture(signal); current();
      return { state, history };
    };
    const run = async (): Promise<ExportResult> => { try {
      current(); const frozenSelection = generalBackupSelection(this.owner.owner.snapshot(), selection).coverage;
      const backupId = randomUUID(), wall = Date.now(), createdAt = Number.isSafeInteger(wall) && wall >= 0 ? wall : null;
      const initial = await capture(), plan = frozenPlan(initial, frozenSelection, backupId, createdAt);
      const candidate = await ports.authorize(plan, signal);
      requireWallet(candidate && typeof candidate.isCurrent === "function" && typeof candidate.close === "function",
        "GENERAL_AUTH_REQUIRED", "A native backup operation is required.");
      authorization = candidate; current();
      lease = this.owner.reserve(); current();
      const stable = await capture();
      requireWallet(frozenPlan(stable, frozenSelection, backupId, createdAt).planDigest === plan.planDigest,
        "GENERAL_BACKUP_HISTORY_CHANGED", "The wallet changed during backup authorization.");
      for (const keyRef of plan.keyRefs) {
        current(); const key = await this.owner.protection.get(keyRef);
        try {
          current(); requireWallet(key?.byteLength === 32, "GENERAL_BACKUP_INVALID", "A selected source key is unavailable.");
          wrappingKeys.push({ keyRef, key: Buffer.from(key!).toString("base64url") });
        } finally { key?.fill(0); }
      }
      const payload = validateGeneralBackupPayload({ format: "koincode-general-wallet", version: 1, backupId, createdAt,
        ownerId: plan.ownerId, installationId: plan.installationId, sourceRevision: plan.sourceRevision, sourceCommitment: plan.sourceCommitment,
        generalSigningPolicyVersion: GENERAL_SIGNING_POLICY_VERSION, policyDigest: GENERAL_SIGNING_POLICY_DIGEST,
        sourceState: stable.state, keyCoverage: plan.keyCoverage, historyCoverage: plan.historyCoverage, signingCoverage: plan.signingCoverage,
        wrappingKeys, history: stable.history });
      let encrypted: GeneralBackupEncrypted;
      try { current(); encrypted = await this.crypto({ operation: "encrypt_backup", payload, password }, signal); current();
        inspectGeneralBackupEnvelope(encrypted.backup);
        requireWallet(encrypted.payloadDigest === digest(payload), "GENERAL_BACKUP_INVALID", "The backup worker returned a different snapshot."); }
      finally { payload.wrappingKeys.forEach((entry) => { entry.key = ""; }); wrappingKeys.forEach((entry) => { entry.key = ""; }); password = ""; }
      const latest = await capture();
      requireWallet(frozenPlan(latest, frozenSelection, backupId, createdAt).planDigest === plan.planDigest,
        "GENERAL_BACKUP_HISTORY_CHANGED", "The wallet changed before backup publication.");
      const metadata = { backupId, ciphertextDigest: createHash("sha256").update(encrypted.backup, "ascii").digest("hex"), byteLength: Buffer.byteLength(encrypted.backup) };
      current(); target = await ports.selectTarget(Object.freeze(metadata), signal); current();
      requireWallet(target && typeof target === "object", "GENERAL_BACKUP_INVALID", "A trusted backup target is required.");
      publicationStarted = true;
      const publication = await ports.publish(target, encrypted.backup, Object.freeze(metadata), current, signal);
      requireWallet(publication && publication.reference === target &&
        publication.ciphertextDigest === metadata.ciphertextDigest && publication.byteLength === metadata.byteLength,
        "GENERAL_BACKUP_EXPORT_UNCERTAIN", "The backup publication could not be confirmed.");
      return { backupId, payloadDigest: encrypted.payloadDigest, sourceKeyCount: plan.keyCoverage.sourceIds.length,
        pendingKeyCount: plan.keyCoverage.pendingSetupIds.length, allReferencedKeys: plan.keyCoverage.sourceIds.length === stable.state.sources.length &&
          plan.keyCoverage.pendingSetupIds.length === stable.state.setups.filter((setup) => setup.pendingKeyRef && !stable.state.sources.some((source) => source.setupId === setup.id)).length,
        publication };
    } catch (error) {
      if (publicationStarted) { this.uncertain = new GeneralBackupExportUncertain(target!); throw this.uncertain; }
      const allowed = ["GENERAL_OPERATION_BUSY", "GENERAL_OPERATION_CANCELED", "GENERAL_BACKUP_HISTORY_CHANGED", "SECRET_ADMISSION_UNAVAILABLE",
        "GENERAL_AUTH_REQUIRED", "GENERAL_BACKUP_INVALID", "GENERAL_CRYPTO_FAILED", "GENERAL_OPERATION_TIMEOUT", "SIGNING_CONTINUITY_UNKNOWN",
        "SIGNING_CONTINUITY_CONFLICT", "SIGNING_JOURNAL_CAPACITY_REACHED", "GENERAL_STORE_UNAVAILABLE", "GENERAL_BACKUP_HISTORY_INVALID"];
      throw new WalletError(error instanceof WalletError && allowed.includes(error.code) ? error.code : "GENERAL_BACKUP_UNAVAILABLE",
        "The protected general wallet backup could not be completed.");
    } };
    let result: ExportResult | undefined, failure: unknown;
    try { result = await run(); } catch (error) { failure = error; }
    password = ""; wrappingKeys.forEach((entry) => { entry.key = ""; }); clearTimeout(timer);
    try { await authorization?.close(); lease?.release(); if (this.active === operation) this.active = undefined; }
    catch {
      this.closed = true;
      if (publicationStarted) this.uncertain = new GeneralBackupExportUncertain(target!);
      this.closeFailure = new WalletError(publicationStarted ? "GENERAL_BACKUP_EXPORT_UNCERTAIN" : "GENERAL_BACKUP_UNAVAILABLE",
        "The native backup operation could not be drained; its original target requires checking.");
      failure = this.uncertain ?? this.closeFailure;
    } finally { finish(); }
    if (failure) throw failure;
    return result!;
  }

  close(): Promise<void> {
    this.closed = true; this.active?.controller.abort();
    return (this.active?.done ?? Promise.resolve()).then(() => { if (this.closeFailure) throw this.closeFailure; });
  }
}
