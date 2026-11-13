import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical } from "./canonical.js";
import { acquireWalletWriter } from "./database.js";
import { preflightGeneralDatabase } from "./generalStoragePreflight.js";
import type { GeneralSigningEvent, GeneralSigningJournalRepository } from "./generalSigningJournal.js";

const MAX_EVENT = 8192;
const MAX_EVENTS = 2000;
const MAX_JOURNAL = 32 * 1024 * 1024;

/** Separate from the general wallet projection and every legacy payment database. */
export class SqliteGeneralSigningJournalRepository implements GeneralSigningJournalRepository {
  private closed = false;
  private constructor(private readonly connection: DatabaseSync, private readonly lease: DatabaseSync,
    private readonly path: string, private readonly device: number, private readonly inode: number) {}

  static open(directory: string, mode: "create" | "open"): SqliteGeneralSigningJournalRepository {
    requireWallet(isAbsolute(directory) && resolve(directory) === directory, "SIGNING_CONTINUITY_UNKNOWN", "Invalid signing journal directory.");
    if (mode === "create" && !existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    requireWallet(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 &&
      (typeof process.getuid !== "function" || info.uid === process.getuid()) && realpathSync(directory) === directory,
    "SIGNING_CONTINUITY_UNKNOWN", "The signing journal directory is not private.");
    const path = join(directory, "general-signing-journal.sqlite");
    const before = preflightGeneralDatabase(path, mode, "SIGNING_CONTINUITY_UNKNOWN");
    const lease = acquireWalletWriter(directory);
    let connection: DatabaseSync | undefined;
    try {
      if (mode === "create") closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
      const file = preflightGeneralDatabase(path, "open", "SIGNING_CONTINUITY_UNKNOWN")!;
      requireWallet(!before || file.dev === before.dev && file.ino === before.ino,
        "SIGNING_CONTINUITY_UNKNOWN", "The signing journal file identity changed.");
      connection = new DatabaseSync(path);
      connection.exec("PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      const version = Number(connection.prepare("PRAGMA user_version").get()?.user_version);
      if (mode === "create") {
        requireWallet(version === 0 && Number(connection.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()?.n) === 0,
          "SIGNING_CONTINUITY_UNKNOWN", "The signing journal file is not new.");
        connection.exec("BEGIN IMMEDIATE; CREATE TABLE signing_events(stream_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_digest TEXT NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(stream_id,sequence)); PRAGMA user_version=1; COMMIT;");
      } else requireWallet(version === 1, "SIGNING_CONTINUITY_UNKNOWN", "The signing journal schema is incompatible.");
      return new SqliteGeneralSigningJournalRepository(connection, lease, path, file.dev, file.ino);
    } catch (error) {
      connection?.close(); lease.close();
      if (error instanceof WalletError) throw error;
      throw new WalletError("SIGNING_CONTINUITY_UNKNOWN", "The signing journal cannot be opened.");
    }
  }

  private verifyFile(): void {
    try {
      const file = lstatSync(this.path);
      requireWallet(!this.closed && file.isFile() && !file.isSymbolicLink() && file.dev === this.device && file.ino === this.inode &&
        (file.mode & 0o077) === 0 && (typeof process.getuid !== "function" || file.uid === process.getuid()),
      "SIGNING_CONTINUITY_UNKNOWN", "The signing journal identity changed.");
    } catch { throw new WalletError("SIGNING_CONTINUITY_UNKNOWN", "The signing journal identity changed."); }
  }

  listStreams(): string[] {
    this.verifyFile();
    const rows = this.connection.prepare("SELECT DISTINCT stream_id FROM signing_events LIMIT 3585").all();
    requireWallet(rows.length <= 3584 && rows.every((row) => typeof row.stream_id === "string" && /^[0-9a-f]{64}$/.test(row.stream_id)),
      "SIGNING_CONTINUITY_CONFLICT", "The signing journal contains invalid streams.");
    return rows.map((row) => row.stream_id as string);
  }

  read(streamId: string): GeneralSigningEvent[] {
    this.verifyFile();
    requireWallet(/^[0-9a-f]{64}$/.test(streamId), "SIGNING_CONTINUITY_UNKNOWN", "The signing stream is invalid.");
    const rows = this.connection.prepare("SELECT sequence, event_digest, event_json FROM signing_events WHERE stream_id=? ORDER BY sequence LIMIT ?")
      .all(streamId, MAX_EVENTS + 1);
    requireWallet(rows.length <= MAX_EVENTS, "SIGNING_JOURNAL_CAPACITY_REACHED", "The signing journal is full.");
    return rows.map((row) => {
      try {
        requireWallet(typeof row.event_json === "string" && Buffer.byteLength(row.event_json) <= MAX_EVENT,
          "SIGNING_CONTINUITY_CONFLICT", "The signing event is invalid.");
        const value = JSON.parse(row.event_json) as GeneralSigningEvent;
        requireWallet(value && canonical(value) === row.event_json && value.streamId === streamId &&
          value.sequence === Number(row.sequence) && value.digest === row.event_digest,
        "SIGNING_CONTINUITY_CONFLICT", "The signing event is invalid.");
        return value;
      } catch { throw new WalletError("SIGNING_CONTINUITY_CONFLICT", "The signing event is invalid."); }
    });
  }

  byteSize(): number {
    this.verifyFile();
    const row = this.connection.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(event_json AS BLOB))),0) AS bytes FROM signing_events").get();
    const count = Number(row?.count), bytes = Number(row?.bytes);
    requireWallet(Number.isSafeInteger(count) && count <= MAX_EVENTS && Number.isSafeInteger(bytes) && bytes <= MAX_JOURNAL,
      "SIGNING_JOURNAL_CAPACITY_REACHED", "The signing journal is full.");
    return bytes;
  }

  append(event: GeneralSigningEvent, previousSequence: number, previousDigest: string): void {
    this.verifyFile();
    const json = canonical(event);
    requireWallet(/^[0-9a-f]{64}$/.test(event.streamId) && /^[0-9a-f]{64}$/.test(event.digest) &&
      event.sequence === previousSequence + 1 && event.previousDigest === previousDigest && Buffer.byteLength(json) <= MAX_EVENT,
    "SIGNING_CONTINUITY_CONFLICT", "The signing event is invalid.");
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.connection.prepare("SELECT sequence,event_digest FROM signing_events WHERE stream_id=? ORDER BY sequence DESC LIMIT 1").get(event.streamId);
      requireWallet(previousSequence === 0 ? !previous : !!previous && Number(previous.sequence) === previousSequence && previous.event_digest === previousDigest,
        "SIGNING_CONTINUITY_CONFLICT", "The signing stream changed unexpectedly.");
      requireWallet(this.byteSize() + Buffer.byteLength(json) <= MAX_JOURNAL,
        "SIGNING_JOURNAL_CAPACITY_REACHED", "The signing journal is full.");
      const count = Number(this.connection.prepare("SELECT count(*) AS n FROM signing_events").get()?.n);
      requireWallet(count < MAX_EVENTS, "SIGNING_JOURNAL_CAPACITY_REACHED", "The signing journal is full.");
      this.connection.prepare("INSERT INTO signing_events(stream_id,sequence,event_digest,event_json) VALUES(?,?,?,?)")
        .run(event.streamId, event.sequence, event.digest, json);
      this.verifyFile();
      this.connection.exec("COMMIT");
    } catch (error) {
      try { this.connection.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.connection.close(); } finally { this.lease.close(); }
  }
}
