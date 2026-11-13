import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ProtectedStore } from "../app/ports.js";
import { assertGeneralStateForward, validateGeneralState, type GeneralWalletState } from "../app/generalState.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical, digest } from "./canonical.js";
import { encodeGeneralStateCheckpoint, readGeneralStateCheckpoint, type GeneralStateRepository } from "./generalGuardedState.js";
import { GeneralRecoveryRecordSession } from "./generalRecoveryRecordSession.js";
import { GeneralRestoreArchiveReader } from "./generalRestoreArchiveReader.js";
import { validateGeneralRestorePlan, type GeneralRestorePlan } from "./generalRestorePlan.js";
import { assertGeneralRestoreDomainBinding, generalLatestProtectedHeadDigest, validateGeneralDomainBinding, type GeneralDomainBinding } from "./generalDomainBinding.js";
import { validateGeneralAssignment, type GeneralAssignment, type GeneralInitializationRecord } from "./generalInitializationRecord.js";
import { generalInitializationPlanDigest } from "./generalInitializationBinding.js";
import { compareGeneralBackupHistories } from "./generalBackupContinuity.js";
import { inspectGeneralRestoreLiveHistory, type GeneralRestoreFact, type GeneralRestoreReadJournal } from "./generalRestoreLiveInspection.js";
import type { GeneralBackupArchive } from "./generalBackupPayload.js";

type Protection = Pick<ProtectedStore, "get">;
type Proof = Readonly<{ canonicalPlan: string; canonicalBinding: string; scopeDigest: string; stateCommitment: string;
  historyDigest: string | null; references: ReadonlyArray<Readonly<GeneralRestoreFact>> }>;
type Ports = { isCurrent(): boolean; verifyNativeResources(input: Proof, signal: AbortSignal): Promise<void> };
type Scope = { digest: string; initialization: GeneralInitializationRecord };
type Snapshot = { state: GeneralWalletState; references: GeneralRestoreFact[]; historyDigest: string | null };
const owners = new WeakMap<Protection, object>();
const conflict = () => new WalletError("GENERAL_RECOVERY_RECORD_CONFLICT", "The original restore target conflicts.");
const unavailable = () => new WalletError("GENERAL_RECOVERY_STORE_UNAVAILABLE", "The native restore target is unavailable.");
const check = (value: unknown): void => { if (!value) throw conflict(); };

/** Purely read-only child of the original restore owner. The supplied views must already be genuinely scoped and open-only. */
export class GeneralRestoreTargetVerifier {
  private readonly plan: GeneralRestorePlan;
  private readonly assignment: GeneralAssignment;
  private readonly token = Object.freeze({});
  private readonly ports: Ports;
  private readonly abort = new AbortController();
  private active?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  constructor(private readonly protection: Protection, private readonly projection: Pick<GeneralStateRepository, "read">,
    private readonly journal: GeneralRestoreReadJournal | null, private readonly records: GeneralRecoveryRecordSession,
    private readonly archives: GeneralRestoreArchiveReader, plan: GeneralRestorePlan, assignment: GeneralAssignment, ports: Ports) {
    this.plan = validateGeneralRestorePlan(plan); this.assignment = validateGeneralAssignment(assignment);
    check(records instanceof GeneralRecoveryRecordSession && archives instanceof GeneralRestoreArchiveReader &&
      typeof protection?.get === "function" && typeof projection?.read === "function" &&
      (journal === null || ["read", "listStreams", "byteSize"].every((key) => typeof journal?.[key as keyof GeneralRestoreReadJournal] === "function")) &&
      typeof ports?.isCurrent === "function" && typeof ports.verifyNativeResources === "function");
    check(this.assignment.ownerId === this.plan.target.ownerId && this.assignment.installationId === this.plan.target.installationId &&
      this.assignment.enrollmentId === this.plan.enrollmentId);
    this.ports = Object.freeze({ isCurrent: ports.isCurrent.bind(ports), verifyNativeResources: ports.verifyNativeResources.bind(ports) });
    requireWallet(!owners.has(protection), "GENERAL_OPERATION_BUSY", "The restore target already has a verification owner.");
    owners.set(protection, this.token);
  }
  verify(plan: GeneralRestorePlan, binding: GeneralDomainBinding, parent?: AbortSignal): Promise<void> {
    return this.run(plan, binding, false, parent);
  }
  /** Opens nothing in create/repair mode and returns no runtime or signing capability. */
  openOnly(plan: GeneralRestorePlan, binding: GeneralDomainBinding, parent?: AbortSignal): Promise<void> {
    return this.run(plan, binding, true, parent);
  }
  private async scope(plan: GeneralRestorePlan, binding: GeneralDomainBinding, opening: boolean, signal: AbortSignal, current: () => void): Promise<Scope> {
    const read = async <T>(get: () => Promise<T>) => { current(); const result = await get(); current(); return result; };
    const stored = await read(() => this.records.readRestore(plan.recoveryId, signal));
    check(stored && stored.phase !== "prepared" && canonical(stored) === canonical(plan));
    const initialization = await read(() => this.records.readInitialization(signal));
    check(initialization && initialization.uid === this.assignment.uid && initialization.ownerId === this.assignment.ownerId &&
      initialization.installationId === this.assignment.installationId && initialization.enrollmentId === this.assignment.enrollmentId &&
      initialization.initializationId === this.assignment.initializationId && initialization.planDigest === this.assignment.initializationDigest);
    const active = await read(() => this.records.readActiveBinding(signal));
    const fixed = await read(() => this.records.readRestoreBinding(plan.recoveryId, signal));
    const history = await read(() => this.records.readHistoricalBinding(binding.bindingDigest, signal));
    const previousHistory = plan.target.previousBindingDigest === null ? null :
      await read(() => this.records.readHistoricalBinding(plan.target.previousBindingDigest!, signal));
    const previous = active?.bindingDigest === plan.target.previousBindingDigest ? active : previousHistory;
    assertGeneralRestoreDomainBinding(binding, this.assignment, plan, previous);
    if (previousHistory) check(canonical(previousHistory) === canonical(previous));
    if (fixed) check(canonical(fixed) === canonical(binding));
    if (history) check(canonical(history) === canonical(binding));
    const published = active !== null && canonical(active) === canonical(binding);
    check(published || canonical(active) === canonical(previous));
    if (published) check(fixed && history && (previous === null || previousHistory));
    if (plan.phase === "keys_staged") check(!published && fixed === null && history === null);
    if (opening || plan.phase === "binding_published" || plan.phase === "reopened")
      check(published && fixed && history && (plan.phase === "binding_published" || plan.phase === "reopened"));
    return { initialization: initialization!, digest: digest({ stored, initialization, active, fixed, history, previous, previousHistory }) };
  }
  private initialization(scope: Scope, plan: GeneralRestorePlan, binding: GeneralDomainBinding, archive: GeneralBackupArchive): void {
    const value = scope.initialization;
    if (plan.mode === "new_installation") {
      check(value.kind === "restore" && value.targetStateCommitment === plan.target.stateCommitment &&
        value.initialSigningDomainId === archive.history.signing.domainId &&
        value.planDigest === generalInitializationPlanDigest(value, plan.planDigest));
    } else {
      check(value.phase === "ready");
      if (value.kind === "new") check(value.planDigest === generalInitializationPlanDigest(value, null));
      // An earlier first-restore digest is not recomputed using this later restore's plan or state.
      if (binding.signing.mode === "live") check(value.kind === "new" && value.initialSigningDomainId === binding.signing.domainId);
    }
  }
  private async snapshot(plan: GeneralRestorePlan, binding: GeneralDomainBinding, archive: GeneralBackupArchive, current: () => void): Promise<Snapshot> {
    current(); const value = await readGeneralStateCheckpoint(this.protection); current(); check(value);
    const state = validateGeneralState(value), projection = validateGeneralState(this.projection.read()); current();
    check(canonical(state) === canonical(projection));
    if (canonical(state) !== canonical(plan.target.state)) { check(plan.phase === "reopened"); assertGeneralStateForward(plan.target.state, state); }
    const encoded = encodeGeneralStateCheckpoint(state), references: GeneralRestoreFact[] = [];
    try { references.push({ reference: "general-state-v1", digest: createHash("sha256").update(encoded).digest("hex") }); } finally { encoded.fill(0); }
    for (const reference of plan.keyRefs) {
      current(); const key = await this.protection.get(reference);
      try { current(); check(key instanceof Uint8Array && key.byteLength === 32);
        references.push({ reference, digest: createHash("sha256").update(key!).digest("hex") }); }
      finally { key?.fill(0); }
    }
    let historyDigest: string | null = null;
    if (binding.signing.mode === "live") {
      check(this.journal);
      const live = await inspectGeneralRestoreLiveHistory(state, this.protection, this.journal!, current); current();
      check(live.history.signing.domainId === binding.signing.domainId && compareGeneralBackupHistories(archive.history, live.history).status === "prefix_consistent");
      if (plan.phase !== "reopened") check(generalLatestProtectedHeadDigest(live.history.signing) === plan.target.latestProtectedHeadDigest);
      references.push(...live.references); historyDigest = digest(live.history);
    } else {
      check(this.journal === null); current(); const registry = await this.protection.get("general-signing-registry-v1");
      try { current(); check(registry === null); references.push({ reference: "general-signing-registry-v1", digest: null }); }
      finally { registry?.fill(0); }
    }
    current(); return { state, references, historyDigest };
  }
  private async run(input: GeneralRestorePlan, candidate: GeneralDomainBinding, opening: boolean, parent?: AbortSignal): Promise<void> {
    requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "A target verification is already running.");
    const plan = validateGeneralRestorePlan(input), binding = validateGeneralDomainBinding(candidate);
    check(canonical({ ...plan, phase: this.plan.phase }) === canonical(this.plan));
    const deadline = new AbortController(), signal = AbortSignal.any([this.abort.signal, deadline.signal, ...(parent ? [parent] : [])]);
    let last = performance.now(); const expiresAt = last + 180000;
    const current = () => {
      const now = performance.now(); if (!Number.isFinite(now) || now < last || now >= expiresAt) deadline.abort(); last = now;
      if (this.closed || signal.aborted) throw new WalletError("GENERAL_RECOVERY_OPERATION_CANCELED", "The original target verification ended.");
      let live = false; try { live = this.ports.isCurrent() === true; } catch { /* No native lifetime means no target access. */ }
      if (!live || owners.get(this.protection) !== this.token) throw unavailable();
    };
    current(); let finish!: () => void;
    const active = new Promise<void>((resolve) => { finish = resolve; }); this.active = active;
    const timer = setTimeout(() => deadline.abort(), 180000); timer.unref();
    try {
      const scope = await this.scope(plan, binding, opening, signal, current); current();
      check(binding.origin.kind === "restore");
      if (binding.origin.kind !== "restore") throw conflict();
      const archive = await this.archives.inspect(binding.origin.artifactId, binding.origin.archiveCiphertextDigest, signal); current();
      this.initialization(scope, plan, binding, archive.archive);
      const first = await this.snapshot(plan, binding, archive.archive, current);
      const proof: Proof = Object.freeze({ canonicalPlan: canonical(plan), canonicalBinding: canonical(binding), scopeDigest: scope.digest,
        stateCommitment: digest(first.state), historyDigest: first.historyDigest,
        references: Object.freeze(first.references.map((entry) => Object.freeze({ ...entry }))) });
      const native = async () => {
        current(); const result: unknown = await this.ports.verifyNativeResources(proof, signal); current();
        if (result !== undefined) throw unavailable();
      };
      await native();
      check((await this.scope(plan, binding, opening, signal, current)).digest === scope.digest);
      const again = await this.snapshot(plan, binding, archive.archive, current); current(); check(digest(again) === digest(first));
      await native(); check((await this.scope(plan, binding, opening, signal, current)).digest === scope.digest); current();
    } catch (error) {
      if (error instanceof WalletError && ["GENERAL_RECOVERY_OPERATION_CANCELED", "GENERAL_RECOVERY_RECORD_CONFLICT", "GENERAL_OPERATION_BUSY"].includes(error.code))
        throw new WalletError(error.code, "The original restore target could not be verified.");
      throw unavailable();
    } finally { clearTimeout(timer); if (this.active === active) this.active = undefined; finish(); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => { await this.active; if (owners.get(this.protection) === this.token) owners.delete(this.protection); });
    this.closed = true; this.abort.abort(); return this.closing;
  }
}
