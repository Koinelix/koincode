import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { REMOTE_HOST_LIMITS, RemoteHostError } from "@fcode/shared";
import { createRemoteHostPrivateDirectory, protectRemoteHostPath } from "./privatePaths.js";
import { migrateRemoteHostV1 } from "./databaseMigration.js";

const DATABASE_NAME = "remote-hosts.sqlite";
const SCHEMA = `
CREATE TABLE remote_metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE remote_hosts (
  host_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, security_revision INTEGER NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE TABLE remote_host_trust (
  host_id TEXT PRIMARY KEY REFERENCES remote_hosts(host_id) ON DELETE CASCADE,
  document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE TABLE remote_secret_records (
  host_id TEXT PRIMARY KEY REFERENCES remote_hosts(host_id) ON DELETE CASCADE,
  credential_version INTEGER NOT NULL, encrypted_payload TEXT NOT NULL
) STRICT;
CREATE TABLE remote_selections (
  selection_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
  document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE TABLE remote_message_bindings (
  selection_id TEXT PRIMARY KEY REFERENCES remote_selections(selection_id),
  session_id TEXT NOT NULL, message_id TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document)), UNIQUE(session_id, message_id)
) STRICT;
CREATE TABLE remote_upload_sources (
  source_id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE TABLE remote_approval_records (
  approval_id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE TABLE remote_executions (
  execution_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, host_id TEXT NOT NULL,
  state TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE INDEX remote_executions_session ON remote_executions(session_id);
CREATE TABLE remote_execution_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL REFERENCES remote_executions(execution_id),
  document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE INDEX remote_execution_events_execution ON remote_execution_events(execution_id, sequence);
CREATE TABLE remote_operation_requests (
  request_key TEXT PRIMARY KEY, input_digest TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
`;

export function normalizeRemoteStorageError(error: unknown): RemoteHostError {
  if (error instanceof RemoteHostError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const sqliteCode = typeof error === "object" && error !== null && "errcode" in error ? Number(error.errcode) & 255 : 0;
  if (code === "ENOSPC" || sqliteCode === 13) {
    return new RemoteHostError("storage_full", "Remote Host storage is full.", "storage");
  }
  if (sqliteCode === 5 || sqliteCode === 6) {
    return new RemoteHostError("storage_busy", "Remote Host storage is busy.", "storage", true);
  }
  return new RemoteHostError("storage_corrupt", "Remote Host storage could not be read or updated.", "storage");
}

export class RemoteHostDatabase {
  private constructor(readonly connection: DatabaseSync, readonly path: string, readonly ownerId: string) {}

  static async open(directory: string): Promise<RemoteHostDatabase> {
    await createRemoteHostPrivateDirectory(directory);
    const filePath = join(directory, DATABASE_NAME);
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(filePath);
      database.exec(`PRAGMA busy_timeout = ${REMOTE_HOST_LIMITS.busyTimeoutMs}; PRAGMA foreign_keys = ON;`);
      const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
      if (version > REMOTE_HOST_LIMITS.schemaVersion) {
        throw new RemoteHostError("schema_incompatible", "This database requires a newer FCode version.", "storage");
      }
      if (version === 0) {
        const tables = database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'").get();
        if (Number(tables?.count) !== 0) {
          throw new RemoteHostError("schema_incompatible", "The existing database has an unrecognized schema.", "storage");
        }
        database.exec("BEGIN IMMEDIATE");
        try {
          database.exec(SCHEMA);
          database.prepare("INSERT INTO remote_metadata(name, value) VALUES (?, ?)").run("owner_id", randomUUID());
          database.prepare("INSERT INTO remote_metadata(name, value) VALUES (?, ?)").run("catalog_revision", "0");
          database.exec(`PRAGMA user_version = ${REMOTE_HOST_LIMITS.schemaVersion}; COMMIT`);
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      if (version === 1) await migrateRemoteHostV1(database, directory);
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      await protectRemoteHostPath(filePath, false);
      for (const suffix of ["-wal", "-shm"]) {
        try { await protectRemoteHostPath(filePath + suffix, false); }
        catch (error) {
          // SQLite creates these files lazily; the private parent protects their creation.
          if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
      const owner = database.prepare("SELECT value FROM remote_metadata WHERE name = ?").get("owner_id")?.value;
      if (typeof owner !== "string" || !owner) throw new RemoteHostError("storage_corrupt", "The database owner is missing.", "storage");
      return new RemoteHostDatabase(database, filePath, owner);
    } catch (error) {
      database?.close();
      throw normalizeRemoteStorageError(error);
    }
  }

  transaction<T>(operation: () => T): T {
    try {
      this.connection.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        this.connection.exec("COMMIT");
        return result;
      } catch (error) {
        this.connection.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      throw normalizeRemoteStorageError(error);
    }
  }

  close(): void { this.connection.close(); }
}
