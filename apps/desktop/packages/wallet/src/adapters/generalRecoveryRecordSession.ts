import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { ProtectedStore } from "../app/ports.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical } from "./canonical.js";
import { generalRecoveryId as id, generalRecoveryUid as uid, generalRecoveryHash as hash } from "./generalRecoveryRecord.js";
import { assertGeneralRestorePlanAdvance, parseGeneralRestorePlan, validateGeneralRestorePlan, type GeneralRestorePlan } from "./generalRestorePlan.js";
import { assertGeneralInitializationAdvance, parseGeneralInitializationRecord, validateGeneralInitializationRecord,
  validateGeneralAssignment, type GeneralAssignment, type GeneralInitializationRecord } from "./generalInitializationRecord.js";
import { assertGeneralRestoreDomainBinding, parseGeneralDomainBinding, validateGeneralDomainBinding, type GeneralDomainBinding } from "./generalDomainBinding.js";
import { assertGeneralBackupJobInput, type GeneralBackupJob } from "./generalBackupEnvelope.js";
import { runGeneralBackupTask, runGeneralHistoryArchiveTask } from "./generalCryptoTask.js";
import { validateGeneralHistoryArchiveEncrypted, type GeneralHistoryArchiveEncrypted } from "./generalHistoryArchiveEnvelope.js";
import type { GeneralBackupDecrypted } from "./generalBackupCrypto.js";
import { stageGeneralRestoreKeys, type GeneralRestoreKeyAdmission } from "./generalRestoreKeyStage.js";

const scopeSchema = z.strictObject({ ownerId: id, installationId: id, enrollmentId: id, initializationId: id, uid });
type Scope = z.infer<typeof scopeSchema>;
type PhasedValue = GeneralRestorePlan | GeneralInitializationRecord;
type RecordValue = PhasedValue | GeneralDomainBinding;
type Descriptor<T extends RecordValue> = { reference: string; parse(bytes: Uint8Array): T; validate(input: unknown): T; scope(record: T): void };
type PhasedDescriptor<T extends PhasedValue> = Descriptor<T> & { advance(previous: unknown, next: unknown): void };
type Connection = { owner?: object; uncertain?: string };
type Admission = (input: Readonly<{ reference: string; canonicalRecord: string }>, signal?: AbortSignal) => Promise<void>;
type BindingPublication = { assignment: GeneralAssignment;
  /** The verified native connection owns CAS, resource checks and old-view revocation. Not a wire format. */
  compareAndPublish(input: Readonly<{ recoveryId: string; planDigest: string; expectedBindingDigest: string | null;
    canonicalCandidate: string }>, signal?: AbortSignal): Promise<void> };
const connections = new WeakMap<ProtectedStore, Connection>();
const unavailable = () => new WalletError("GENERAL_RECOVERY_STORE_UNAVAILABLE", "The protected recovery record is unavailable.");
const invalid = () => new WalletError("GENERAL_RECOVERY_RECORD_INVALID", "The protected recovery record could not be verified.");
export class GeneralRecoveryWriteUncertain extends WalletError {
  constructor(readonly reference: string) { super("GENERAL_RECOVERY_WRITE_UNCERTAIN", "The original recovery record requires inspection before further writes."); }
}

/** Owns only the approved metadata records on one verified native connection. This grants no native or signing authority. */
export class GeneralRecoveryRecordSession {
  private readonly scope: Scope;
  private readonly connection: Connection;
  private readonly token = Object.freeze({});
  private active?: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  private readonly bindingPublication?: BindingPublication;
  private readonly abort = new AbortController();
  constructor(private readonly protection: ProtectedStore, input: Scope, private readonly isCurrent: () => boolean,
    private readonly admitNewRecord: Admission, publication?: BindingPublication) {
    try {
      this.scope = scopeSchema.parse(input);
      if (publication !== undefined) {
        const assignment = validateGeneralAssignment(publication.assignment);
        if (typeof publication.compareAndPublish !== "function" || assignment.uid !== this.scope.uid ||
            assignment.initializationId !== this.scope.initializationId || assignment.ownerId !== this.scope.ownerId ||
            assignment.installationId !== this.scope.installationId || assignment.enrollmentId !== this.scope.enrollmentId) throw invalid();
        this.bindingPublication = { assignment: Object.freeze(assignment), compareAndPublish: publication.compareAndPublish.bind(publication) };
      }
    }
    catch { throw invalid(); }
    const connection = connections.get(protection) ?? {};
    requireWallet(!connection.owner, "GENERAL_OPERATION_BUSY", "The protected recovery connection already has an owner.");
    connection.owner = this.token; this.connection = connection; connections.set(protection, connection);
  }

  async readRestore(recoveryId: string, signal?: AbortSignal): Promise<GeneralRestorePlan | null> {
    const descriptor = this.restore(recoveryId);
    return this.run(false, signal, () => this.read(descriptor, signal));
  }
  async prepareRestore(input: GeneralRestorePlan, signal?: AbortSignal): Promise<GeneralRestorePlan> {
    const record = validateGeneralRestorePlan(input);
    return this.prepare(this.restore(record.recoveryId), record, signal);
  }
  async advanceRestore(previous: GeneralRestorePlan, next: GeneralRestorePlan, signal?: AbortSignal): Promise<GeneralRestorePlan> {
    const before = validateGeneralRestorePlan(previous);
    return this.advance(this.restore(before.recoveryId), before, next, signal);
  }
  /** Protected restore UI only. Actual worker decryption precedes all target-key access; no key is returned. */
  async stageRestoreKeys(input: GeneralRestorePlan, file: { backup: string; password: string }, admission: GeneralRestoreKeyAdmission,
    signal?: AbortSignal): Promise<GeneralRestorePlan> {
    return this.stageRestoreMaterials(input, file, admission, signal);
  }
  /** Keeps authenticated payload private and hands the combined caller only an encrypted archive candidate. */
  async stageRestoreKeysWithArchive(input: GeneralRestorePlan, file: { backup: string; password: string }, admission: GeneralRestoreKeyAdmission,
    signal?: AbortSignal): Promise<{ plan: GeneralRestorePlan; archive: GeneralHistoryArchiveEncrypted | null }> {
    const pending: { archive?: GeneralHistoryArchiveEncrypted } = {};
    try {
      const plan = await this.stageRestoreMaterials(input, file, admission, signal, pending); this.check(signal);
      return { plan, archive: pending.archive ?? null };
    } catch (error) { if (pending.archive) pending.archive.archive = ""; throw error; }
  }
  private async stageRestoreMaterials(input: GeneralRestorePlan, file: { backup: string; password: string }, admission: GeneralRestoreKeyAdmission,
    signal?: AbortSignal, pending?: { archive?: GeneralHistoryArchiveEncrypted }): Promise<GeneralRestorePlan> {
    const plan = validateGeneralRestorePlan(input), descriptor = this.restore(plan.recoveryId);
    requireWallet(typeof admission?.admitKey === "function", "GENERAL_RECOVERY_STORE_UNAVAILABLE", "The native material admission port is unavailable.");
    const admitKey = admission.admitKey.bind(admission), deadline = new AbortController();
    let lastTime = performance.now(); const expiresAt = lastTime + 180000;
    const combined = AbortSignal.any([this.abort.signal, deadline.signal, ...(signal ? [signal] : [])]);
    const job: Extract<GeneralBackupJob, { operation: "decrypt_backup" }> = { operation: "decrypt_backup", backup: file.backup, password: file.password };
    const timer = setTimeout(() => deadline.abort(), 180000); timer.unref();
    const current = () => {
      const now = performance.now();
      if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || now < lastTime || now >= expiresAt) deadline.abort();
      lastTime = now;
      this.check(combined);
    };
    try {
      assertGeneralBackupJobInput(job);
      const ports: Parameters<typeof stageGeneralRestoreKeys>[2] = { protection: this.protection,
        current, readPlan: () => this.read(descriptor, combined), admitKey,
        decrypt: (request, currentSignal) => runGeneralBackupTask<GeneralBackupDecrypted>(request, currentSignal),
        markUncertain: (reference) => { this.connection.uncertain ??= reference; },
        uncertain: (reference) => { this.connection.uncertain ??= reference; throw new GeneralRecoveryWriteUncertain(this.connection.uncertain); },
        advance: (previous, next) => { descriptor.advance(previous, next); return this.write(descriptor, canonical(next), combined); },
      };
      if (pending) ports.encryptArchive = async (payload, staged, currentSignal) => {
        const artifactId = randomUUID(); current();
        const encrypted: unknown = await runGeneralHistoryArchiveTask({ operation: "encrypt_archive", payload, plan: staged, artifactId }, currentSignal);
        current(); pending.archive = validateGeneralHistoryArchiveEncrypted(encrypted, staged, artifactId);
      };
      const result = await this.run(true, combined, () => stageGeneralRestoreKeys(plan, job, ports, combined));
      current(); return result;
    } finally { clearTimeout(timer); job.password = ""; job.backup = ""; }
  }
  async readInitialization(signal?: AbortSignal): Promise<GeneralInitializationRecord | null> {
    return this.run(false, signal, () => this.read(this.initialization(), signal));
  }
  async prepareInitialization(input: GeneralInitializationRecord, signal?: AbortSignal): Promise<GeneralInitializationRecord> {
    return this.prepare(this.initialization(), input, signal);
  }
  async advanceInitialization(previous: GeneralInitializationRecord, next: GeneralInitializationRecord, signal?: AbortSignal): Promise<GeneralInitializationRecord> {
    return this.advance(this.initialization(), previous, next, signal);
  }

  async readActiveBinding(signal?: AbortSignal): Promise<GeneralDomainBinding | null> {
    return this.run(false, signal, () => this.read(this.binding("active"), signal));
  }
  async readHistoricalBinding(bindingDigest: string, signal?: AbortSignal): Promise<GeneralDomainBinding | null> {
    const descriptor = this.binding("history", bindingDigest);
    return this.run(false, signal, () => this.read(descriptor, signal));
  }
  async readRestoreBinding(recoveryId: string, signal?: AbortSignal): Promise<GeneralDomainBinding | null> {
    const descriptor = this.binding("restore", recoveryId);
    return this.run(false, signal, () => this.read(descriptor, signal));
  }
  async prepareHistoricalBinding(input: GeneralDomainBinding, signal?: AbortSignal): Promise<GeneralDomainBinding> {
    const row = validateGeneralDomainBinding(input);
    return this.create(this.binding("history", row.bindingDigest), row, signal, (before, next) => canonical(before) === canonical(next));
  }
  async prepareRestoreBinding(planValue: GeneralRestorePlan, input: GeneralDomainBinding, previousValue: GeneralDomainBinding | null,
    signal?: AbortSignal): Promise<GeneralDomainBinding> {
    const { plan, candidate } = this.restoreBindingInput(planValue, input, previousValue);
    return this.create(this.binding("restore", plan.recoveryId), candidate, signal, (before, next) => canonical(before) === canonical(next),
      async (existing) => {
        const record = await this.requirePlan(plan, signal);
        requireWallet(existing !== null || record.phase === "projection_staged", "GENERAL_RECOVERY_RECORD_CONFLICT", "The original restore candidate is unavailable.");
      });
  }

  /** Active publication never uses ProtectedStore.put and never grants signing authority. */
  async publishRestoreBinding(planValue: GeneralRestorePlan, input: GeneralDomainBinding, previousValue: GeneralDomainBinding | null,
    signal?: AbortSignal): Promise<GeneralDomainBinding> {
    const { plan, candidate, previous, publication } = this.restoreBindingInput(planValue, input, previousValue);
    const active = this.binding("active"), text = canonical(candidate);
    return this.run(true, signal, async () => {
      const record = await this.requirePlan(plan, signal);
      const fixed = await this.read(this.binding("restore", plan.recoveryId), signal);
      const copy = await this.read(this.binding("history", candidate.bindingDigest), signal);
      requireWallet(fixed && copy && canonical(fixed) === text && canonical(copy) === text,
        "GENERAL_RECOVERY_RECORD_CONFLICT", "The original restore candidate and immutable copy are required.");
      if (previous) {
        const predecessor = await this.read(this.binding("history", previous.bindingDigest), signal);
        requireWallet(predecessor && canonical(predecessor) === canonical(previous),
          "GENERAL_RECOVERY_RECORD_CONFLICT", "The original predecessor copy is required.");
      }
      const current = await this.read(active, signal);
      if (current && canonical(current) === text) return current;
      requireWallet(record.phase === "projection_staged" && (previous ? current && canonical(current) === canonical(previous) : current === null),
        "GENERAL_RECOVERY_RECORD_CONFLICT", "The active binding is not the original predecessor.");
      this.check(signal);
      let checked: GeneralDomainBinding | null;
      try {
        const result: unknown = await publication.compareAndPublish(Object.freeze({ recoveryId: plan.recoveryId, planDigest: plan.planDigest,
          expectedBindingDigest: candidate.previousBindingDigest, canonicalCandidate: text }), signal);
        requireWallet(result === undefined, "GENERAL_RECOVERY_RECORD_INVALID", "The native publication response was invalid.");
        // Admitted CAS drains and reads its exact metadata even if the caller canceled during the write.
        checked = await this.read(active, undefined, true);
        requireWallet(checked && canonical(checked) === text, "GENERAL_RECOVERY_RECORD_INVALID", "The active binding readback did not match.");
      } catch {
        this.connection.uncertain ??= active.reference;
        throw new GeneralRecoveryWriteUncertain(this.connection.uncertain);
      }
      this.check(signal); return checked;
    });
  }

  private restoreBindingInput(planValue: unknown, candidateValue: unknown, previousValue: unknown | null) {
    const publication = this.bindingPublication;
    requireWallet(publication, "GENERAL_BINDING_PUBLISH_UNAVAILABLE", "The verified native binding publication port is unavailable.");
    const plan = validateGeneralRestorePlan(planValue), candidate = validateGeneralDomainBinding(candidateValue);
    const previous = previousValue === null ? null : validateGeneralDomainBinding(previousValue);
    assertGeneralRestoreDomainBinding(candidate, publication.assignment, plan, previous);
    return { plan, candidate, previous, publication };
  }
  private async requirePlan(plan: GeneralRestorePlan, signal?: AbortSignal): Promise<GeneralRestorePlan> {
    const record = await this.read(this.restore(plan.recoveryId), signal);
    requireWallet(record && canonical({ ...record, phase: plan.phase }) === canonical(plan) &&
      ["projection_staged", "binding_published", "reopened"].includes(record.phase),
    "GENERAL_RECOVERY_RECORD_CONFLICT", "The same staged restore plan is required.");
    return record;
  }
  private binding(kind: "active" | "history" | "restore", key?: string): Descriptor<GeneralDomainBinding> {
    if (kind === "history" && !hash.safeParse(key).success || kind === "restore" && !id.safeParse(key).success) throw invalid();
    const reference = kind === "active" ? "general-domain-binding-v1" : kind === "history" ? `general-domain-binding:${key}` : `general-restore-binding:${key}`;
    return { reference, parse: parseGeneralDomainBinding, validate: validateGeneralDomainBinding, scope: (record) => {
      if (record.uid !== this.scope.uid || record.ownerId !== this.scope.ownerId || record.installationId !== this.scope.installationId ||
          record.enrollmentId !== this.scope.enrollmentId || kind === "history" && record.bindingDigest !== key ||
          kind === "restore" && (record.origin.kind !== "restore" || record.origin.recoveryId !== key) ||
          record.origin.kind === "new" && (record.origin.initializationId !== this.scope.initializationId ||
            this.bindingPublication && record.origin.initializationDigest !== this.bindingPublication.assignment.initializationDigest)) throw invalid();
    } };
  }

  private restore(recoveryId: string): PhasedDescriptor<GeneralRestorePlan> {
    requireWallet(id.safeParse(recoveryId).success, "GENERAL_RECOVERY_RECORD_INVALID", "The recovery identity is invalid.");
    return { reference: `general-restore-plan:${recoveryId}`, parse: parseGeneralRestorePlan, validate: validateGeneralRestorePlan,
      advance: assertGeneralRestorePlanAdvance, scope: (record) => {
        if (record.recoveryId !== recoveryId || record.enrollmentId !== this.scope.enrollmentId ||
            record.target.ownerId !== this.scope.ownerId || record.target.installationId !== this.scope.installationId) throw invalid();
      } };
  }
  private initialization(): PhasedDescriptor<GeneralInitializationRecord> {
    return { reference: "general-initialization-v1", parse: parseGeneralInitializationRecord, validate: validateGeneralInitializationRecord,
      advance: assertGeneralInitializationAdvance, scope: (record) => {
        if (record.initializationId !== this.scope.initializationId || record.uid !== this.scope.uid || record.enrollmentId !== this.scope.enrollmentId ||
            record.ownerId !== this.scope.ownerId || record.installationId !== this.scope.installationId) throw invalid();
      } };
  }
  private check(signal?: AbortSignal): void {
    requireWallet(!this.closed && !signal?.aborted, "GENERAL_RECOVERY_OPERATION_CANCELED", "The recovery record operation ended; reopen its original record.");
    let live = false;
    try { live = this.isCurrent() === true; } catch { /* A failed native lifetime lookup grants no record access. */ }
    requireWallet(this.connection.owner === this.token && live,
      "GENERAL_RECOVERY_STORE_UNAVAILABLE", "The native recovery record lifetime is unavailable.");
  }
  private async run<T>(writable: boolean, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    try {
      this.check(signal);
      requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "A recovery record operation is already running.");
      if (writable && this.connection.uncertain) throw new GeneralRecoveryWriteUncertain(this.connection.uncertain);
      let finish!: () => void;
      const active = new Promise<void>((resolve) => { finish = resolve; }); this.active = active;
      try { const result = await work(); this.check(signal); return result; }
      finally { if (this.active === active) this.active = undefined; finish(); }
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw unavailable();
    }
  }
  private async read<T extends RecordValue>(descriptor: Descriptor<T>, signal?: AbortSignal, drainingWrite = false): Promise<T | null> {
    if (!drainingWrite) this.check(signal);
    let bytes: Uint8Array | null;
    try { bytes = await this.protection.get(descriptor.reference); } catch { throw unavailable(); }
    try {
      if (!drainingWrite) this.check(signal);
      if (bytes === null) return null;
      try { const value = descriptor.parse(bytes); descriptor.scope(value); return value; }
      catch { this.connection.uncertain ??= descriptor.reference; throw invalid(); }
    } finally { if (bytes instanceof Uint8Array) Uint8Array.prototype.fill.call(bytes, 0); }
  }
  private prepare<T extends PhasedValue>(descriptor: PhasedDescriptor<T>, input: T, signal?: AbortSignal): Promise<T> {
    const value = descriptor.validate(input); descriptor.scope(value);
    requireWallet(value.phase === "prepared", "GENERAL_RECOVERY_RECORD_CONFLICT", "Only the original prepared record can be created.");
    return this.create(descriptor, value, signal, (existing, next) => {
      const { phase: _old, ...before } = existing, { phase: _new, ...after } = next;
      return canonical(before) === canonical(after);
    });
  }
  private create<T extends RecordValue>(descriptor: Descriptor<T>, input: T, signal: AbortSignal | undefined,
    matches: (existing: T, next: T) => boolean, preflight?: (existing: T | null) => Promise<void>): Promise<T> {
    const value = descriptor.validate(input); descriptor.scope(value);
    const text = canonical(value);
    return this.run(true, signal, async () => {
      const existing = await this.read(descriptor, signal);
      if (preflight) { await preflight(existing); this.check(signal); }
      if (existing) {
        requireWallet(matches(existing, value), "GENERAL_RECOVERY_RECORD_CONFLICT", "A different recovery record already exists.");
        return existing;
      }
      try { await this.admitNewRecord(Object.freeze({ reference: descriptor.reference, canonicalRecord: text }), signal); }
      catch {
        this.check(signal);
        throw new WalletError("GENERAL_RECOVERY_CREATE_NOT_ADMITTED", "The native operation did not admit creation of this recovery record.");
      }
      this.check(signal);
      return this.write(descriptor, text, signal);
    });
  }
  private advance<T extends PhasedValue>(descriptor: PhasedDescriptor<T>, previous: T, input: T, signal?: AbortSignal): Promise<T> {
    const before = descriptor.validate(previous), next = descriptor.validate(input);
    descriptor.scope(before); descriptor.scope(next); descriptor.advance(before, next);
    const original = canonical(before), text = canonical(next);
    return this.run(true, signal, async () => {
      const existing = await this.read(descriptor, signal);
      requireWallet(existing, "GENERAL_RECOVERY_RECORD_CONFLICT", "The original recovery record is missing.");
      const current = canonical(existing);
      if (current === text) return existing;
      requireWallet(current === original, "GENERAL_RECOVERY_RECORD_CONFLICT", "The recovery record changed before this transition.");
      return this.write(descriptor, text, signal);
    });
  }
  private async write<T extends RecordValue>(descriptor: Descriptor<T>, text: string, signal?: AbortSignal): Promise<T> {
    this.check(signal);
    const bytes = Buffer.from(text);
    let checked: T | null;
    try {
      try {
        await this.protection.put(descriptor.reference, bytes);
        checked = await this.read(descriptor, undefined, true);
        requireWallet(checked && canonical(checked) === text, "GENERAL_RECOVERY_RECORD_INVALID", "The recovery record readback did not match.");
      } catch {
        this.connection.uncertain ??= descriptor.reference;
        throw new GeneralRecoveryWriteUncertain(this.connection.uncertain);
      }
    } finally { bytes.fill(0); }
    this.check(signal);
    return checked;
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = (this.active ?? Promise.resolve()).then(() => { if (this.connection.owner === this.token) this.connection.owner = undefined; });
      this.abort.abort();
    }
    return this.closing;
  }
}
