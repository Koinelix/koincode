import type { ProtectedStore } from "../app/ports.js";
import type { GeneralSigningJournalRepository } from "../app/generalSigningTypes.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical } from "./canonical.js";
import { GeneralBackupHistoryReader } from "./generalBackupHistory.js";
import type { GeneralStateRepository } from "./generalGuardedState.js";
import { validateGeneralAssignment, type GeneralAssignment } from "./generalInitializationRecord.js";
import { validateGeneralHistoryArchiveEncrypted, type GeneralHistoryArchiveEncrypted } from "./generalHistoryArchiveEnvelope.js";
import { GeneralRecoveryRecordSession } from "./generalRecoveryRecordSession.js";
import { GeneralRestoreArchiveReader } from "./generalRestoreArchiveReader.js";
import { GeneralRestoreLiveHistoryStage } from "./generalRestoreLiveHistoryStage.js";
import { validateGeneralRestorePlan, type GeneralRestorePlan } from "./generalRestorePlan.js";
import type { GeneralRestorePublicationPorts, GeneralRestorePublicationScope } from "./generalRestorePublication.js";
import { GeneralRestoreStateStage } from "./generalRestoreStateStage.js";
import { GeneralRestoreTargetVerifier } from "./generalRestoreTargetVerifier.js";
import type { GeneralRestoreKeyAdmission } from "./generalRestoreKeyStage.js";

type RecordArguments = ConstructorParameters<typeof GeneralRecoveryRecordSession>;
type LivePorts = ConstructorParameters<typeof GeneralRestoreLiveHistoryStage>[3];
type Connection = { owner?: object; unsafe?: boolean };
const connections = new WeakMap<object, Connection>();
const unavailable = () => new WalletError("GENERAL_RECOVERY_STORE_UNAVAILABLE", "The original native restore scope is unavailable.");
const check = (value: unknown): void => requireWallet(value, "GENERAL_RECOVERY_RECORD_CONFLICT", "The original restore scope conflicts.");
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
};

/** Private client ports, not native wire or permission. All views must come from the same genuine recovery capability. */
export type GeneralRestoreScopeBackend = {
  assignment: GeneralAssignment;
  protection: ProtectedStore;
  /** Lazy native staging view: absence permits no creation without prepareCheckpoint. */
  projection: GeneralStateRepository;
  files: ConstructorParameters<typeof GeneralRestoreArchiveReader>[3];
  keyAdmission: GeneralRestoreKeyAdmission;
  admitNewRecord: RecordArguments[3];
  compareAndPublish: NonNullable<RecordArguments[4]>["compareAndPublish"];
  prepareCheckpoint: ConstructorParameters<typeof GeneralRestoreStateStage>[3]["prepareCheckpoint"];
  publishArchive(plan: Readonly<GeneralRestorePlan>, candidate: Readonly<GeneralHistoryArchiveEncrypted>, signal: AbortSignal): Promise<void>;
  verifyNativeResources: ConstructorParameters<typeof GeneralRestoreTargetVerifier>[7]["verifyNativeResources"];
  /** Original formal open-only adapter after publication; validation alone cannot report an actual reopen. */
  openTarget: GeneralRestorePublicationScope["openTarget"];
  live: null | {
    source: { history: GeneralBackupHistoryReader; protection: Pick<ProtectedStore, "get"> };
    prepareJournal: LivePorts["prepareJournal"];
    /** Open-only, including after prepareJournal; never repair or create from file absence. */
    openJournal: LivePorts["openJournal"];
    admitReference: LivePorts["admitReference"];
  };
  isCurrent(): boolean;
  /** Drains original native operations and all unclaimed views; never closes the source runtime. */
  close(): Promise<void>;
};
type Native = { authorize(plan: Readonly<GeneralRestorePlan>, signal: AbortSignal): Promise<GeneralRestoreScopeBackend> };

/** Composes clients only. The runtime/enrollment owner and native backend retain all authority and source leases. */
export class GeneralRestoreScopeFactory implements GeneralRestorePublicationPorts {
  private readonly connection: Connection;
  private readonly authorizeNative: Native["authorize"];
  private readonly token = Object.freeze({});
  constructor(native: Native) {
    check(typeof native?.authorize === "function"); this.authorizeNative = native.authorize.bind(native);
    this.connection = connections.get(native) ?? {}; connections.set(native, this.connection);
  }
  async authorize(input: GeneralRestorePlan, signal: AbortSignal): Promise<GeneralRestorePublicationScope> {
    const plan = freeze(validateGeneralRestorePlan(input));
    if (signal.aborted) throw new WalletError("GENERAL_RECOVERY_OPERATION_CANCELED", "The restore authorization ended.");
    requireWallet(!this.connection.owner && !this.connection.unsafe, "GENERAL_OPERATION_BUSY", "The original restore connection is busy or unavailable.");
    this.connection.owner = this.token;
    let backend: GeneralRestoreScopeBackend;
    try { backend = await this.authorizeNative(plan, signal); }
    catch { this.connection.unsafe = true; throw unavailable(); }
    let release: (() => Promise<void>) | undefined, claimed = false;
    try {
      check(backend && typeof backend.close === "function"); release = backend.close.bind(backend);
      const scope = await this.assemble(plan, backend, signal, release, () => { claimed = true; });
      if (signal.aborted || !scope.isCurrent()) { await scope.close(); throw unavailable(); }
      return scope;
    } catch {
      // assemble owns cleanup once it succeeds. Before that the native backend owns every unclaimed resource.
      if (!claimed && this.connection.owner === this.token) {
        try { const result: unknown = await release?.(); if (!release || result !== undefined) throw unavailable();
          this.connection.owner = undefined;
        } catch { this.connection.unsafe = true; }
      }
      throw unavailable();
    }
  }

  private async assemble(plan: GeneralRestorePlan, backend: GeneralRestoreScopeBackend, parent: AbortSignal,
    closeNative: () => Promise<void>, claim: () => void): Promise<GeneralRestorePublicationScope> {
    const assignment = freeze(validateGeneralAssignment(backend.assignment));
    check(assignment.ownerId === plan.target.ownerId && assignment.installationId === plan.target.installationId && assignment.enrollmentId === plan.enrollmentId);
    const protection = backend.protection, projection = backend.projection, files = backend.files;
    check(["get", "put"].every((key) => typeof protection?.[key as keyof ProtectedStore] === "function") &&
      ["read", "write", "close"].every((key) => typeof projection?.[key as keyof GeneralStateRepository] === "function") &&
      ["isCurrent", "list", "open", "close"].every((key) => typeof files?.[key as keyof typeof files] === "function") &&
      ["admitNewRecord", "compareAndPublish", "prepareCheckpoint", "publishArchive", "verifyNativeResources", "openTarget", "isCurrent"]
        .every((key) => typeof backend[key as keyof GeneralRestoreScopeBackend] === "function") && typeof backend.keyAdmission?.admitKey === "function");
    const livePorts = backend.live;
    check(plan.target.signingContinuity === "complete" ? plan.mode === "same_installation" && livePorts &&
      livePorts.source.history instanceof GeneralBackupHistoryReader && livePorts.source.protection !== protection &&
      ["prepareJournal", "openJournal", "admitReference"].every((key) => typeof livePorts[key as keyof typeof livePorts] === "function") : livePorts === null);
    const nativeCurrent = backend.isCurrent.bind(backend), prepareCheckpoint = backend.prepareCheckpoint.bind(backend);
    const publishArchive = backend.publishArchive.bind(backend), verifyNativeResources = backend.verifyNativeResources.bind(backend);
    const openTarget = backend.openTarget.bind(backend);
    const compareAndPublish = backend.compareAndPublish.bind(backend), admitNewRecord = backend.admitNewRecord.bind(backend);
    const keyAdmission = Object.freeze({ admitKey: backend.keyAdmission.admitKey.bind(backend.keyAdmission) });
    const abort = new AbortController(), signal = AbortSignal.any([parent, abort.signal]);
    let closed = false, active: Promise<void> | undefined, closing: Promise<void> | undefined;
    let records: GeneralRecoveryRecordSession | undefined, state: GeneralRestoreStateStage | undefined;
    let archives: GeneralRestoreArchiveReader | undefined, live: GeneralRestoreLiveHistoryStage | undefined, verifier: GeneralRestoreTargetVerifier | undefined;
    let journal: GeneralSigningJournalRepository | undefined, liveOwnsJournal = false;
    const isCurrent = () => {
      try { return !closed && !signal.aborted && this.connection.owner === this.token && !this.connection.unsafe && nativeCurrent() === true; }
      catch { return false; }
    };
    const current = () => { if (!isCurrent()) throw unavailable(); };
    const samePlan = (value: GeneralRestorePlan) => {
      const checked = validateGeneralRestorePlan(value); check(canonical({ ...checked, phase: plan.phase }) === canonical(plan)); return freeze(checked);
    };
    const run = async <T>(inputPlan: GeneralRestorePlan, operationSignal: AbortSignal, work: (value: GeneralRestorePlan, signal: AbortSignal) => Promise<T>) => {
      current(); requireWallet(!active, "GENERAL_OPERATION_BUSY", "A restore scope command is already running.");
      const value = samePlan(inputPlan), combined = AbortSignal.any([signal, operationSignal]);
      let finish!: () => void; active = new Promise<void>((resolve) => { finish = resolve; });
      try {
        if (combined.aborted) throw unavailable();
        const stored = await records!.readRestore(plan.recoveryId, combined); current(); check(canonical(stored) === canonical(value));
        const result = await work(value, combined); current(); if (combined.aborted) throw unavailable(); return result;
      } finally { active = undefined; finish(); }
    };
    const close = (): Promise<void> => {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        const recordDrain = records?.close();
        await active;
        const checkedClose = async (work: () => unknown) => { const value: unknown = await work(); if (value !== undefined) throw unavailable(); };
        await checkedClose(() => verifier?.close());
        const results = await Promise.allSettled([
          checkedClose(() => live?.close()), checkedClose(() => archives?.close()), checkedClose(() => state?.close()),
          checkedClose(() => recordDrain), checkedClose(() => !liveOwnsJournal ? journal?.close() : undefined),
        ]);
        if (results.some((result) => result.status === "rejected")) { this.connection.unsafe = true; throw unavailable(); }
        try { await checkedClose(closeNative); }
        catch { this.connection.unsafe = true; throw unavailable(); }
        if (this.connection.owner === this.token) this.connection.owner = undefined;
      });
      closed = true; abort.abort(); return closing;
    };
    claim();
    try {
      current();
      records = new GeneralRecoveryRecordSession(protection, { uid: assignment.uid, ownerId: assignment.ownerId,
        installationId: assignment.installationId, enrollmentId: assignment.enrollmentId, initializationId: assignment.initializationId }, isCurrent,
      admitNewRecord, { assignment, compareAndPublish });
      state = new GeneralRestoreStateStage(projection, protection, plan, { isCurrent, prepareCheckpoint,
        readPlan: () => records!.readRestore(plan.recoveryId, signal) });
      archives = new GeneralRestoreArchiveReader(records, protection, plan, files);
    } catch (error) {
      // Construction is synchronous and grants no IO. Keep partially constructed client ownership until drained.
      try { await close(); } catch { this.connection.unsafe = true; }
      throw error;
    }
    const openJournal = livePorts?.openJournal.bind(livePorts);
    const acquireJournal = async (currentSignal: AbortSignal) => {
      current(); if (journal) return journal;
      journal = await openJournal!(currentSignal);
      check(journal && ["listStreams", "read", "append", "byteSize", "close"].every((key) => typeof journal![key as keyof GeneralSigningJournalRepository] === "function"));
      current(); return journal;
    };
    const inspect = async (value: GeneralRestorePlan, binding: Parameters<GeneralRestorePublicationScope["verifyTarget"]>[1], currentSignal: AbortSignal, opening: boolean) => {
      if (livePorts && !journal) await acquireJournal(currentSignal);
      verifier ??= new GeneralRestoreTargetVerifier(protection, projection, journal ?? null, records!, archives!, plan, assignment, { isCurrent, verifyNativeResources });
      if (opening) await verifier.openOnly(value, binding, currentSignal); else await verifier.verify(value, binding, currentSignal);
    };
    return { records, state, assignment, keyAdmission, isCurrent, close,
      verifiedArchives: (value, currentSignal) => run(value, currentSignal, async (_plan, combined) => (await archives!.inventory(combined)).verified),
      prepareArchive: (value, currentSignal, candidate) => run(value, currentSignal, async (original, combined) => {
        check(original.phase === "keys_staged");
        requireWallet(candidate, "GENERAL_BACKUP_INVALID", "Select the original encrypted backup before publishing its history archive.");
        const ciphertext = freeze(validateGeneralHistoryArchiveEncrypted(candidate, original, candidate!.artifactId));
        const result: unknown = await publishArchive(original, ciphertext, combined); check(result === undefined);
      }),
      prepareLiveHistory: (value, currentSignal) => run(value, currentSignal, async (original, combined) => {
        check(livePorts && original.phase === "keys_staged");
        live ??= new GeneralRestoreLiveHistoryStage(livePorts!.source, protection, original, {
          isCurrent, readPlan: () => records!.readRestore(plan.recoveryId, signal), prepareJournal: livePorts!.prepareJournal.bind(livePorts),
          openJournal: async (copySignal) => { const result = await acquireJournal(copySignal); liveOwnsJournal = true; return result; },
          admitReference: livePorts!.admitReference.bind(livePorts),
        });
        await live.stage(combined);
      }),
      verifyTarget: (value, binding, currentSignal) => run(value, currentSignal, (original, combined) => inspect(original, binding, combined, false)),
      openTarget: (value, binding, currentSignal) => run(value, currentSignal, async (original, combined) => {
        await inspect(original, binding, combined, true); current();
        const result: unknown = await openTarget(original, freeze(structuredClone(binding)), combined); check(result === undefined); current();
        await inspect(original, binding, combined, true);
      }),
    };
  }
}
