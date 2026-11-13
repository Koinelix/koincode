import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ProtectedStore } from "../app/ports.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical, digest } from "./canonical.js";
import { GeneralRecoveryRecordSession } from "./generalRecoveryRecordSession.js";
import { generalRecoveryHash, generalRecoveryId } from "./generalRecoveryRecord.js";
import { assertGeneralRestoreArchiveInput, validateGeneralRestorePlan, type GeneralRestorePlan } from "./generalRestorePlan.js";
import { GENERAL_BACKUP_MAX_BYTES, validateGeneralBackupArchive } from "./generalBackupPayload.js";
import { generalHistoryArchiveHeader, inspectGeneralHistoryArchive, type GeneralHistoryArchiveJob } from "./generalHistoryArchiveEnvelope.js";
import type { GeneralHistoryArchiveDecrypted } from "./generalHistoryArchiveCrypto.js";
import { runGeneralHistoryArchiveTask } from "./generalCryptoTask.js";

type FileHandle = { read(signal: AbortSignal): Promise<string>; verify(ciphertextDigest: string, signal: AbortSignal): Promise<void>; close(): Promise<void> };
type Files = { isCurrent(): boolean; list(signal: AbortSignal): Promise<string[]>;
  open(artifactId: string, signal: AbortSignal): Promise<FileHandle>; close(): Promise<void> };
type Crypto = (job: Extract<GeneralHistoryArchiveJob, { operation: "decrypt_archive" }>, signal: AbortSignal) => Promise<unknown>;
type Connection = { owner?: object; unsafe?: boolean; closed?: boolean };
type Metadata = Pick<GeneralHistoryArchiveDecrypted, "artifactId" | "archiveCiphertextDigest">;
export type GeneralRestoreArchiveInventory = { verified: Metadata[]; unverifiedArtifactIds: string[] };
const connections = new WeakMap<Files, Connection>();
const conflict = () => new WalletError("GENERAL_RECOVERY_RECORD_CONFLICT", "The original archive scope could not be verified.");
const unavailable = () => new WalletError("GENERAL_RECOVERY_STORE_UNAVAILABLE", "The original archive reader is unavailable.");
const invalid = () => new WalletError("GENERAL_HISTORY_ARCHIVE_INVALID", "The protected history archive could not be verified.");
const canceled = () => new WalletError("GENERAL_RECOVERY_OPERATION_CANCELED", "The original archive operation ended.");
const check = (value: unknown): void => { if (!value) throw conflict(); };

/** Private authenticated history reader. The genuine file/key adapters must belong to this same native recovery scope. */
export class GeneralRestoreArchiveReader {
  private readonly plan: GeneralRestorePlan;
  private readonly connection: Connection;
  private readonly token = Object.freeze({});
  private readonly files: Files;
  private readonly getKey: ProtectedStore["get"];
  private readonly abort = new AbortController();
  private active?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  constructor(private readonly records: GeneralRecoveryRecordSession, protection: Pick<ProtectedStore, "get">,
    input: GeneralRestorePlan, backend: Files, private readonly crypto: Crypto = runGeneralHistoryArchiveTask) {
    this.plan = validateGeneralRestorePlan(input);
    check(records instanceof GeneralRecoveryRecordSession && typeof protection?.get === "function" && typeof crypto === "function" &&
      ["isCurrent", "list", "open", "close"].every((key) => typeof backend?.[key as keyof Files] === "function"));
    this.files = Object.freeze({ isCurrent: backend.isCurrent.bind(backend), list: backend.list.bind(backend),
      open: backend.open.bind(backend), close: backend.close.bind(backend) }); this.getKey = protection.get.bind(protection);
    this.connection = connections.get(backend) ?? {};
    requireWallet(!this.connection.owner, "GENERAL_OPERATION_BUSY", "The archive backend already has an owner.");
    check(!this.connection.closed && !this.connection.unsafe);
    this.connection.owner = this.token; connections.set(backend, this.connection);
  }

  /** Private history only, never a renderer result or signer. A fixed candidate additionally pins the exact ciphertext. */
  inspect(artifactId: string, expectedCiphertextDigest?: string, parent?: AbortSignal): Promise<GeneralHistoryArchiveDecrypted> {
    check(generalRecoveryId.safeParse(artifactId).success &&
      (expectedCiphertextDigest === undefined || generalRecoveryHash.safeParse(expectedCiphertextDigest).success));
    return this.run(parent, (signal, current, original) => this.readOne(artifactId, expectedCiphertextDigest, signal, current, original));
  }

  /** Deterministically invalid files remain visible and retained; they never become verified candidates. */
  inventory(parent?: AbortSignal): Promise<GeneralRestoreArchiveInventory> {
    return this.run(parent, async (signal, current, original) => {
      const ids = await this.list(signal, current), result: GeneralRestoreArchiveInventory = { verified: [], unverifiedArtifactIds: [] };
      for (const artifactId of ids) {
        try {
          const value = await this.readOne(artifactId, undefined, signal, current, original);
          result.verified.push({ artifactId, archiveCiphertextDigest: value.archiveCiphertextDigest });
        } catch (error) {
          current(); await original();
          if (error instanceof WalletError && error.code === "GENERAL_HISTORY_ARCHIVE_INVALID" && !this.connection.unsafe)
            result.unverifiedArtifactIds.push(artifactId);
          else throw error;
        }
      }
      check(canonical(await this.list(signal, current)) === canonical(ids)); await original(); current(); return result;
    });
  }
  private async list(signal: AbortSignal, current: () => void): Promise<string[]> {
    current(); const ids = await this.files.list(signal); current();
    check(Array.isArray(ids) && ids.length <= 8 && ids.every((id) => generalRecoveryId.safeParse(id).success) && new Set(ids).size === ids.length);
    return [...ids].sort();
  }
  private async readOne(artifactId: string, expectedDigest: string | undefined, signal: AbortSignal, current: () => void,
    original: () => Promise<GeneralRestorePlan>): Promise<GeneralHistoryArchiveDecrypted> {
    const plan = await original(); current();
    let closeHandle: (() => Promise<void>) | undefined;
    let ciphertext = "", key: Uint8Array | null = null;
    let job: Extract<GeneralHistoryArchiveJob, { operation: "decrypt_archive" }> | undefined;
    let inspected: GeneralHistoryArchiveDecrypted | undefined, failure: unknown, failed = false;
    try {
      let handle: FileHandle;
      try { handle = await this.files.open(artifactId, signal); }
      catch { this.connection.unsafe = true; throw unavailable(); }
      if (handle && typeof handle.close === "function") closeHandle = handle.close.bind(handle);
      else { this.connection.unsafe = true; throw unavailable(); }
      current();
      if (typeof handle.read !== "function" || typeof handle.verify !== "function") throw unavailable();
      const read = handle.read.bind(handle), verify = handle.verify.bind(handle);
      ciphertext = await read(signal); current();
      if (typeof ciphertext !== "string" || ciphertext.length === 0 || Buffer.byteLength(ciphertext) > GENERAL_BACKUP_MAX_BYTES ||
          !/^[\x20-\x7e]+$/.test(ciphertext)) throw invalid();
      if (canonical(inspectGeneralHistoryArchive(ciphertext)) !== canonical(generalHistoryArchiveHeader(plan, artifactId))) throw invalid();
      const ciphertextDigest = createHash("sha256").update(ciphertext, "ascii").digest("hex");
      if (expectedDigest !== undefined && ciphertextDigest !== expectedDigest) throw invalid();
      await original(); current(); key = await this.getKey(plan.keyRefs[0]!); current();
      if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw conflict();
      const activeJob = { operation: "decrypt_archive" as const, archive: ciphertext, key, plan, artifactId }; job = activeJob;
      let output: unknown;
      try { current(); output = await this.crypto(activeJob, signal); current(); }
      finally { activeJob.key.fill(0); activeJob.archive = ""; key = null; job = undefined; ciphertext = ""; }
      if (!output || typeof output !== "object" || Array.isArray(output) ||
          Object.keys(output).sort().join() !== "archive,archiveCiphertextDigest,archiveDigest,artifactId") throw unavailable();
      const row = output as GeneralHistoryArchiveDecrypted;
      if (row.artifactId !== artifactId || row.archiveCiphertextDigest !== ciphertextDigest || row.archiveDigest !== plan.target.archiveDigest) throw unavailable();
      const archive = validateGeneralBackupArchive(row.archive); assertGeneralRestoreArchiveInput(plan, archive);
      if (digest(archive) !== row.archiveDigest) throw unavailable();
      await original(); current();
      const result: unknown = await verify(ciphertextDigest, signal); current();
      if (result !== undefined) throw unavailable();
      await original(); current();
      inspected = { archive, artifactId, archiveDigest: row.archiveDigest, archiveCiphertextDigest: ciphertextDigest };
    } catch (error) { failed = true; failure = error;
    } finally {
      if (key instanceof Uint8Array) key.fill(0);
      if (job) { job.key.fill(0); job.archive = ""; } ciphertext = "";
      if (closeHandle) {
        try { const result: unknown = await closeHandle(); if (result !== undefined) this.connection.unsafe = true; }
        catch { this.connection.unsafe = true; }
      }
    }
    if (this.connection.unsafe) throw unavailable();
    if (failed) throw failure;
    if (!inspected) throw unavailable();
    return inspected;
  }

  private async run<T>(parent: AbortSignal | undefined,
    work: (signal: AbortSignal, current: () => void, original: () => Promise<GeneralRestorePlan>) => Promise<T>): Promise<T> {
    if (this.connection.unsafe || this.connection.closed) throw unavailable();
    requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "An archive command is already running.");
    const deadline = new AbortController(), signal = AbortSignal.any([this.abort.signal, deadline.signal, ...(parent ? [parent] : [])]);
    let last = performance.now(); const expiresAt = last + 180000;
    const current = () => {
      const now = performance.now(); if (!Number.isFinite(now) || now < last || now >= expiresAt) deadline.abort(); last = now;
      if (this.closed || signal.aborted) throw canceled();
      let live = false; try { live = this.files.isCurrent() === true; } catch { /* A failed native lifetime grants no key/file access. */ }
      if (!live || this.connection.owner !== this.token || this.connection.unsafe || this.connection.closed) throw unavailable();
    };
    current(); let finish!: () => void;
    const active = new Promise<void>((resolve) => { finish = resolve; }); this.active = active;
    const timer = setTimeout(() => deadline.abort(), 180000); timer.unref();
    let snapshot: GeneralRestorePlan | undefined;
    const original = async () => {
      current(); const stored = await this.records.readRestore(this.plan.recoveryId, signal); current();
      check(stored && stored.phase !== "prepared" && canonical({ ...stored, phase: this.plan.phase }) === canonical(this.plan));
      const value = validateGeneralRestorePlan(stored);
      if (!snapshot) snapshot = value; else check(canonical(value) === canonical(snapshot));
      return value;
    };
    try { await original(); const result = await work(signal, current, original); await original(); current(); return result; }
    catch (error) {
      if (error instanceof WalletError && ["GENERAL_HISTORY_ARCHIVE_INVALID", "GENERAL_RECOVERY_OPERATION_CANCELED",
        "GENERAL_RECOVERY_RECORD_CONFLICT", "GENERAL_OPERATION_BUSY"].includes(error.code))
        throw new WalletError(error.code, "The original archive operation could not be completed.");
      throw unavailable();
    } finally { clearTimeout(timer); if (this.active === active) this.active = undefined; finish(); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      await this.active;
      try { const result: unknown = await this.files.close(); if (result !== undefined) throw unavailable(); }
      catch { this.connection.unsafe = true; throw unavailable(); }
      this.connection.closed = true;
      if (this.connection.owner === this.token) this.connection.owner = undefined;
    });
    this.closed = true; this.abort.abort(); return this.closing;
  }
}
