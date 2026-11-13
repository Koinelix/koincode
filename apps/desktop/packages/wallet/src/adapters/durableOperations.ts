import { DatabaseSync } from "node:sqlite";
import { lstatSync, fstatSync, openSync, closeSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { requestDigest } from "../app/requestFacts.js";
import { validateInput } from "../domain/requestValidation.js";
import { requireWallet } from "../domain/errors.js";
import type { JournalCommitter, JournalInitializationTicket } from "../domain/operationJournal.js";
import { issueJournalInitialization } from "../app/journalInitialization.js";
import { OPERATION_JOURNAL_LIMIT } from "../domain/operationJournal.js";
import { assertOperationSchema, operationJournalDigest, OPERATION_SCHEMA } from "./operationJournalDigest.js";
const MAX_PENDING_PREPARES = 32;
// This is the caller's durable action identity journal, never a second wallet or budget.
export class DurableOperationAdapter {
  #queue: Promise<unknown> = Promise.resolve();
  #pending = 0;
  #closed = false;
  #broken = false;
  #initialization?: JournalInitializationTicket;
  private constructor(
    fresh: boolean,
    private readonly path: string,
    private readonly identity: string,
    private readonly db: DatabaseSync,
    private readonly clientId: string,
  ) {
    if (fresh) this.#initialization = issueJournalInitialization(clientId, requestDigest([path, clientId]));
  }
  /** Trusted host setup only. Never use as recovery from a failed open or lookup. */
  static create(path: string, clientId: string): DurableOperationAdapter {
    validatePath(path, clientId);
    const fd = openSync(path, "wx", 0o600);
    try {
      const created = fstatSync(fd, { bigint: true });
      return this.connect(path, clientId, true, `${created.dev}:${created.ino}`);
    } finally {
      closeSync(fd);
    }
  }
  static open(path: string, clientId: string): DurableOperationAdapter {
    validatePath(path, clientId);
    return this.connect(path, clientId, false);
  }
  /** Trusted bootstrap only, after protected history proves that no operation was ever anchored. */
  static resumeInitialization(path: string, clientId: string): DurableOperationAdapter {
    const journal = this.open(path, clientId);
    try {
      requireWallet(operationJournalDigest(journal.db, clientId).count === 0,
        "OPERATION_HISTORY_INCOMPLETE", "An existing operation journal cannot be reinitialized.");
      journal.#initialization = issueJournalInitialization(clientId, requestDigest([path, clientId]));
      return journal;
    } catch (error) { journal.close(); throw error; }
  }
  private static connect(path: string, clientId: string, fresh: boolean, createdIdentity?: string): DurableOperationAdapter {
    const identity = fileIdentity(path);
    requireWallet(createdIdentity === undefined || createdIdentity === identity, "OPERATION_CONTEXT_REQUIRED",
      "The newly created operation journal was replaced.");
    // SQLite must not recreate a file removed after the identity check.
    const uri = pathToFileURL(path);
    uri.searchParams.set("mode", "rw");
    const db = new DatabaseSync(uri.href);
    try {
      requireWallet(fileIdentity(path) === identity, "OPERATION_CONTEXT_REQUIRED",
        "The operation journal was replaced.");
      if (fresh) db.exec(OPERATION_SCHEMA);
      // Reopening must never repair an empty, unrelated or damaged database.
      assertOperationSchema(db);
      db.exec("PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      return new DurableOperationAdapter(fresh, path, identity, db, clientId);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  private assertFile(): void {
    validatePath(this.path, this.clientId);
    requireWallet(fileIdentity(this.path) === this.identity, "OPERATION_CONTEXT_REQUIRED",
      "The original operation journal is unavailable.");
  }
  prepare(sourceId: string, input: unknown): { operationId: string; inputDigest: string } {
    requireWallet(!this.#pending && !this.#closed && !this.#broken, "OPERATION_CONTEXT_REQUIRED",
      "The operation journal is unavailable or preparing an anchored mapping.");
    requireWallet(
      typeof sourceId === "string" && sourceId.length > 0 && sourceId.length <= 256,
      "OPERATION_CONTEXT_REQUIRED",
      "A trusted host action identity is required.",
    );
    const inputDigest = requestDigest(validateInput(input));
    this.assertFile();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          "SELECT input_digest,operation_id FROM operation_sources WHERE client_id=? AND source_id=?",
        )
        .get(this.clientId, sourceId);
      if (existing) {
        requireWallet(
          existing.input_digest === inputDigest,
          "REQUEST_CONFLICT",
          "The host action already has different input.",
        );
        this.assertFile();
        this.db.exec("COMMIT");
        return { operationId: String(existing.operation_id), inputDigest };
      }
      const operationId = randomUUID();
      this.db
        .prepare("INSERT INTO operation_sources VALUES(?,?,?,?)")
        .run(this.clientId, sourceId, inputDigest, operationId);
      this.assertFile();
      this.db.exec("COMMIT");
      return { operationId, inputDigest };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  prepareAnchored(sourceId: string, input: unknown, authority: JournalCommitter): Promise<{ operationId: string; inputDigest: string }> {
    requireWallet(typeof sourceId === "string" && sourceId.length > 0 && sourceId.length <= 256,
      "OPERATION_CONTEXT_REQUIRED", "A trusted host action identity is required.");
    requireWallet(!this.#closed && !this.#broken && this.#pending < MAX_PENDING_PREPARES,
      "OPERATION_CONTEXT_REQUIRED", "The operation journal is unavailable or busy.");
    const inputDigest = requestDigest(validateInput(input));
    this.#pending++;
    const operation = this.#queue.then(async () => {
      requireWallet(!this.#broken && !this.#closed, "OPERATION_HISTORY_INCOMPLETE",
        "The operation journal requires recovery.");
      this.assertFile();
      this.db.exec("BEGIN IMMEDIATE");
      let transactionOpen = true, anchored = false;
      try {
        assertOperationSchema(this.db);
        const before = operationJournalDigest(this.db, this.clientId);
        const existing = this.db.prepare("SELECT input_digest,operation_id FROM operation_sources WHERE client_id=? AND source_id=?")
          .get(this.clientId, sourceId);
        requireWallet(!existing || existing.input_digest === inputDigest,
          "REQUEST_CONFLICT", "The host action already has different input.");
        const operationId = existing ? String(existing.operation_id) : randomUUID();
        if (!existing) {
          requireWallet(before.count < OPERATION_JOURNAL_LIMIT, "OPERATION_HISTORY_INCOMPLETE",
            "The operation journal inventory is full.");
          this.db.prepare("INSERT INTO operation_sources VALUES(?,?,?,?)")
            .run(this.clientId, sourceId, inputDigest, operationId);
        }
        const after = operationJournalDigest(this.db, this.clientId);
        await authority.commit({ clientId: this.clientId, binding: requestDigest([this.path, this.clientId]),
          initialization: this.#initialization, before, after });
        anchored = true;
        this.assertFile();
        this.db.exec("COMMIT"); transactionOpen = false;
        this.assertFile();
        return { operationId, inputDigest };
      } catch (error) {
        if (anchored) this.#broken = true;
        if (transactionOpen) {
          try { this.db.exec("ROLLBACK"); } catch { this.#broken = true; }
        }
        throw error;
      }
    }).finally(() => { this.#pending--; });
    this.#queue = operation.catch(() => {});
    return operation;
  }
  close(): void {
    requireWallet(this.#pending === 0, "OPERATION_CONTEXT_REQUIRED",
      "Pending journal preparations must settle before close.");
    if (!this.#closed) { this.db.close(); this.#closed = true; }
  }
}

function validatePath(path: string, clientId: string): void {
  requireWallet(resolve(path) === path && realpathSync(dirname(path)) === dirname(path) &&
    typeof clientId === "string" && clientId.length > 0 && clientId.length <= 100,
  "UNSAFE_STORAGE_PATH", "A canonical host-approved operation journal is required.");
}

function fileIdentity(path: string): string {
  const info = lstatSync(path, { bigint: true });
  requireWallet(info.isFile() && !info.isSymbolicLink() && info.nlink === 1n && (info.mode & 0o077n) === 0n,
    "UNSAFE_STORAGE_PATH", "A private regular operation journal without extra links is required.");
  return `${info.dev}:${info.ino}`;
}
