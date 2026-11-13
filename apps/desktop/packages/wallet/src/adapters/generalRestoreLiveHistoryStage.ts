import { createHash, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ProtectedStore } from "../app/ports.js";
import type { GeneralSigningJournalRepository } from "../app/generalSigningTypes.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical, digest } from "./canonical.js";
import { GeneralBackupHistoryReader, type GeneralBackupHistory } from "./generalBackupHistory.js";
import { generalLatestProtectedHeadDigest } from "./generalDomainBinding.js";
import { parseGeneralSigningCheckpoint } from "./generalSigningJournal.js";
import { inspectGeneralSignedMaterial } from "./generalSignedMaterial.js";
import { parseGeneralBroadcastRecord } from "./generalBroadcastRecord.js";
import { validateGeneralRestorePlan, type GeneralRestorePlan } from "./generalRestorePlan.js";

type Protection = Pick<ProtectedStore, "get" | "put">;
type Connection = { owner?: object; uncertain?: boolean };
type Reference = { reference: string; bytes: Uint8Array | null };
type Ports = {
  readPlan(): Promise<GeneralRestorePlan | null>;
  isCurrent(): boolean;
  prepareJournal(input: Readonly<{ canonicalPlan: string; checkpointDigest: string;
    references: ReadonlyArray<Readonly<{ reference: string; digest: string | null }>> }>, signal: AbortSignal): Promise<void>;
  openJournal(signal: AbortSignal): Promise<GeneralSigningJournalRepository>;
  admitReference(input: Readonly<{ recoveryId: string; planDigest: string; reference: string; valueDigest: string }>, signal: AbortSignal): Promise<void>;
};
const connections = new WeakMap<Protection, Connection>();
const repositories = new WeakMap<GeneralSigningJournalRepository, object>();
const fail = (code = "GENERAL_RECOVERY_RECORD_CONFLICT") => new WalletError(code, "The original live restore history could not be verified.");
const check = (value: unknown): void => requireWallet(value, "GENERAL_RECOVERY_RECORD_CONFLICT", "The original live restore history conflicts.");
const equal = (a: Uint8Array | null, b: Uint8Array | null): boolean => a === null || b === null ? a === b : a.byteLength === b.byteLength && timingSafeEqual(a, b);

/** Private target-copy step under the runtime's existing snapshot lease. This never creates a signing owner or native authority. */
export class GeneralRestoreLiveHistoryStage {
  private readonly plan: GeneralRestorePlan;
  private readonly token = Object.freeze({});
  private readonly connection: Connection;
  private readonly abort = new AbortController();
  private repository?: GeneralSigningJournalRepository;
  private active?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  constructor(private readonly source: { history: GeneralBackupHistoryReader; protection: Pick<ProtectedStore, "get"> },
    private readonly target: Protection, input: GeneralRestorePlan, private readonly ports: Ports) {
    check(["readPlan", "isCurrent", "prepareJournal", "openJournal", "admitReference"].every((key) => typeof ports?.[key as keyof Ports] === "function"));
    this.source = Object.freeze({ history: source.history, protection: source.protection });
    this.ports = Object.freeze(Object.fromEntries(["readPlan", "isCurrent", "prepareJournal", "openJournal", "admitReference"]
      .map((key) => [key, ports?.[key as keyof Ports]?.bind(ports)]))) as Ports;
    this.plan = validateGeneralRestorePlan(input);
    check(source.history instanceof GeneralBackupHistoryReader && source.protection !== target &&
      this.plan.mode === "same_installation" && this.plan.target.signingContinuity === "complete" && this.plan.phase === "keys_staged");
    this.connection = connections.get(target) ?? {};
    requireWallet(!this.connection.owner, "GENERAL_OPERATION_BUSY", "The live restore target already has an owner.");
    this.connection.owner = this.token; connections.set(target, this.connection);
  }

  async stage(parent?: AbortSignal): Promise<void> {
    requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "A live history command is already running.");
    if (this.connection.uncertain) throw fail("GENERAL_RECOVERY_WRITE_UNCERTAIN");
    const abort = new AbortController(), signal = AbortSignal.any([this.abort.signal, abort.signal, ...(parent ? [parent] : [])]);
    const started = performance.now(), deadline = started + 180000; let last = started, admitted = false;
    const current = () => {
      const now = performance.now();
      if (!Number.isFinite(now) || now < last || now >= deadline) abort.abort(); last = now;
      if (this.closed || signal.aborted) throw fail("GENERAL_RECOVERY_OPERATION_CANCELED");
      let live = false; try { live = this.ports.isCurrent() === true; } catch { /* A failed native lifetime grants no access. */ }
      requireWallet(live && this.connection.owner === this.token, "GENERAL_RECOVERY_STORE_UNAVAILABLE", "The native live restore scope ended.");
    };
    current();
    let finish!: () => void;
    const active = new Promise<void>((resolve) => { finish = resolve; }); this.active = active;
    const timer = setTimeout(() => abort.abort(), 180000); timer.unref();
    const references: Reference[] = [], owned: Uint8Array[] = [];
    let totalBytes = 0;
    const readSource = async (reference: string, maximum: number): Promise<Uint8Array | null> => {
      current(); const bytes = await this.source.protection.get(reference);
      if (bytes instanceof Uint8Array) owned.push(bytes); current();
      check(bytes === null || bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= maximum);
      totalBytes += bytes?.byteLength ?? 0; check(totalBytes <= 48 * 1024 * 1024);
      references.push({ reference, bytes }); return bytes;
    };
    const effect = async (work: () => Promise<unknown>) => {
      await originalPlan(); current(); admitted = true;
      const result = await work(); current(); check(result === undefined); await originalPlan();
    };
    const originalPlan = async () => {
      current(); const stored = await this.ports.readPlan(); current();
      check(stored && canonical(validateGeneralRestorePlan(stored)) === canonical(this.plan));
    };
    const capture = async () => {
      current(); const history = await this.source.history.capture(signal); current();
      this.verifyHistory(history); return history;
    };
    const sourceUnchanged = async (history: GeneralBackupHistory) => {
      check(digest(await capture()) === digest(history));
      for (const entry of references) {
        current(); const bytes = await this.source.protection.get(entry.reference);
        try { current(); check(equal(bytes, entry.bytes)); } finally { bytes?.fill(0); }
      }
      await originalPlan();
    };
    try {
      await originalPlan();
      const history = await capture(), checkpoint = history.signing;
      const intents = new Map(history.intents.map((entry) => [entry.riskId, entry.preview]));
      const registry = { format: "koincode-general-signing-registry", version: 1, ownerId: checkpoint.ownerId,
        installationId: checkpoint.installationId, domainId: checkpoint.domainId,
        signingPolicyVersion: checkpoint.signingPolicyVersion, signingPolicyDigest: checkpoint.signingPolicyDigest,
        streams: checkpoint.streams.map(({ events: _events, ...stream }) => stream) };
      let events = 0, risks = 0;
      for (const stream of checkpoint.streams) {
        events += stream.events.length; check(events <= 2000);
        for (const event of stream.events) if (event.phase === "SIGNING_POSSIBLE") {
          check(++risks <= 1000);
          const risk = event.risk, preview = intents.get(risk.riskId); check(preview);
          const intent = await readSource(`general-intent:${risk.riskId}`, 16384);
          check(intent && Buffer.from(intent).toString("utf8") === canonical({ format: "koincode-general-transfer-intent", version: 1, riskId: risk.riskId, preview }));
          const signed = stream.events.find((item) => item.phase === "SIGNED" && item.risk.riskId === risk.riskId);
          const material = await readSource(`general-signed:${risk.riskId}`, 16384);
          let hash: string | undefined;
          if (material) {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(material), value: unknown = JSON.parse(text);
            check(value && typeof value === "object" && !Array.isArray(value));
            const expected = inspectGeneralSignedMaterial(preview!, risk.intentDigest, risk.riskId, (value as { signedTransaction: string }).signedTransaction);
            check(canonical(expected) === text && (!signed || expected.transactionHash === signed.transactionHash)); hash = expected.transactionHash;
          } else check(!signed);
          const broadcast = await readSource(`general-broadcast:${risk.riskId}`, 4096);
          if (broadcast) {
            check(signed && hash);
            parseGeneralBroadcastRecord(Uint8Array.from(broadcast), preview!, risk.intentDigest, risk.riskId, hash!);
          }
        }
      }
      check(intents.size === risks);
      const registryBytes = await readSource("general-signing-registry-v1", 512 * 1024);
      check(registryBytes && Buffer.from(registryBytes).toString("utf8") === canonical(registry));
      await sourceUnchanged(history); current();
      if (!this.repository) {
        await effect(() => this.ports.prepareJournal(Object.freeze({ canonicalPlan: canonical(this.plan), checkpointDigest: digest(checkpoint),
          references: Object.freeze(references.map((entry) => Object.freeze({ reference: entry.reference, digest: entry.bytes ? digestBytes(entry.bytes) : null }))) }), signal));
        admitted = true;
        const repository = await this.ports.openJournal(signal);
        check(repository && ["read", "append", "listStreams", "byteSize", "close"].every((key) => typeof repository[key as keyof GeneralSigningJournalRepository] === "function"));
        check(!repositories.has(repository));
        this.repository = repository; repositories.set(repository, this.token); current();
      }
      this.verifyEvents(checkpoint, false); current();
      // Validate the entire existing target before the first copy, including optional source absences.
      for (const entry of references) await this.targetValue(entry, true, current);
      for (const entry of references.slice(0, -1)) await this.copy(entry, signal, current, effect);
      for (const stream of checkpoint.streams) {
        const present = this.repository.read(stream.id); current();
        for (const event of stream.events.slice(present.length)) {
          await originalPlan(); current(); admitted = true;
          const result: unknown = this.repository.append(structuredClone(event), event.sequence - 1, event.previousDigest);
          check(result === undefined); current();
        }
      }
      await this.copy(references.at(-1)!, signal, current, effect);
      this.verifyEvents(checkpoint, true);
      for (const entry of references) await this.targetValue(entry, false, current);
      await sourceUnchanged(history); current();
    } catch (error) {
      if (admitted) { this.connection.uncertain = true; throw fail("GENERAL_RECOVERY_WRITE_UNCERTAIN"); }
      if (error instanceof WalletError) throw error;
      throw fail();
    } finally {
      clearTimeout(timer); for (const bytes of owned) bytes.fill(0); references.length = 0; owned.length = 0;
      if (this.active === active) this.active = undefined; finish();
    }
  }

  private verifyHistory(history: GeneralBackupHistory): void {
    const plan = this.plan;
    check(history.ownerId === plan.target.ownerId && history.installationId === plan.target.installationId &&
      history.sourceRevision === plan.target.state.revision && history.sourceCommitment === plan.target.stateCommitment &&
      generalLatestProtectedHeadDigest(history.signing) === plan.target.latestProtectedHeadDigest);
    const bytes = Buffer.from(canonical(history.signing));
    try { check(parseGeneralSigningCheckpoint(bytes).policy === "v3"); } finally { bytes.fill(0); }
  }
  private verifyEvents(checkpoint: GeneralBackupHistory["signing"], complete: boolean): void {
    const repo = this.repository!;
    check(Number.isSafeInteger(repo.byteSize()) && repo.byteSize() >= 0 && repo.byteSize() <= 32 * 1024 * 1024);
    const listed = repo.listStreams(), expected = new Set(checkpoint.streams.map((entry) => entry.id));
    check(new Set(listed).size === listed.length && listed.every((id) => expected.has(id)));
    for (const stream of checkpoint.streams) {
      const present = repo.read(stream.id);
      check(Array.isArray(present) && present.length <= stream.events.length && (!complete || present.length === stream.events.length) &&
        present.every((event, index) => canonical(event) === canonical(stream.events[index])));
      check(present.length === 0 || listed.includes(stream.id));
    }
  }
  private async targetValue(entry: Reference, allowMissing: boolean, current: () => void): Promise<boolean> {
    current(); const bytes = await this.target.get(entry.reference);
    try { current(); check(equal(bytes, entry.bytes) || allowMissing && bytes === null && entry.bytes !== null); return bytes !== null; }
    finally { bytes?.fill(0); }
  }
  private async copy(entry: Reference, signal: AbortSignal, current: () => void, effect: (work: () => Promise<unknown>) => Promise<void>): Promise<void> {
    if (await this.targetValue(entry, true, current) || !entry.bytes) return;
    await effect(() => this.ports.admitReference(Object.freeze({ recoveryId: this.plan.recoveryId, planDigest: this.plan.planDigest,
      reference: entry.reference, valueDigest: digestBytes(entry.bytes!) }), signal));
    await effect(() => this.target.put(entry.reference, entry.bytes!));
    await this.targetValue(entry, false, current);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      await this.active;
      try { const result: unknown = this.repository?.close(); check(result === undefined); }
      catch { this.connection.uncertain = true; throw fail("GENERAL_RECOVERY_STORE_UNAVAILABLE"); }
      if (this.repository && repositories.get(this.repository) === this.token) repositories.delete(this.repository);
      if (this.connection.owner === this.token) this.connection.owner = undefined;
    });
    this.closed = true; this.abort.abort(); return this.closing;
  }
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
