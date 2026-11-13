import { migrateGeneralSources } from "./generalSourceMigration.js";
import {
  markFreshStore,
  markOpenedStore,
  issueInitialization,
  beginInitialization,
  consumeInitializationAttempt,
  verifyReadyInitialState,
} from "./initializationAuthority.js";
import type { InitializationAttempt, InitializationTicket } from "../app/state.js";
import { backup, DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  realpathSync,
  renameSync,
  unlinkSync,
  fsyncSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WalletError, requireWallet } from "../domain/errors.js";
import { migrateTransport } from "./transportMigration.js";
import { migrateJournalAnchors } from "./journalMigration.js";
import { migrateResponseRetention } from "./retentionMigration.js";
import { SCHEMA, SCHEMA_VERSION, GENERAL_SOURCE_SCHEMA, GENERAL_SOURCE_SCHEMA_VERSION } from "./schema.js";

function privateFile(path: string): void {
  if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
  const info = lstatSync(path);
  requireWallet(
    info.isFile() && !info.isSymbolicLink(),
    "UNSAFE_STORAGE_PATH",
    "A private regular file is required.",
  );
  chmodSync(path, 0o600);
}

export function acquireWalletWriter(directory: string): DatabaseSync {
  const path = join(directory, "writer-lease.sqlite");
  privateFile(path);
  const lease = new DatabaseSync(path);
  try {
    lease.exec("PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS writer_guard (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;");
    return lease;
  } catch {
    lease.close();
    throw new WalletError("WALLET_WRITER_BUSY", "The wallet database writer is already running.");
  }
}

export class WalletDatabase {
  private closed = false;
  private constructor(
    readonly connection: DatabaseSync,
    private readonly lease: DatabaseSync,
    readonly directory: string,
  ) {}
  static create(directory: string, installationId?: string): WalletDatabase {
    return this.openFile(directory, true, undefined, undefined, installationId);
  }
  /** Fresh database only; never upgrades an existing wallet or copies keys. */
  static createWithGeneralSources(directory: string, installationId?: string): WalletDatabase {
    return this.openFile(directory, true, undefined, undefined, installationId, GENERAL_SOURCE_SCHEMA_VERSION);
  }
  upgradeGeneralSources(): { backupPath: string } { return migrateGeneralSources(this.connection, this.directory); }
  get schemaVersion(): number { return Number(this.connection.prepare("PRAGMA user_version").get()?.user_version); }
  static createForRecovery(directory: string, ownerId: string, installationId?: string): WalletDatabase {
    requireWallet(
      /^[0-9a-f-]{36}$/.test(ownerId),
      "BACKUP_INVALID",
      "An authenticated recovery owner identity is required.",
    );
    return this.openFile(directory, true, ownerId, undefined, installationId);
  }
  static openExisting(directory: string): WalletDatabase {
    return this.openFile(directory, false);
  }
  private static openFile(
    directory: string,
    create: boolean,
    recoveredOwnerId?: string,
    heldLease?: DatabaseSync,
    installationId?: string,
    freshSchema = SCHEMA_VERSION,
  ): WalletDatabase {
    requireWallet(
      resolve(directory) === directory,
      "UNSAFE_STORAGE_PATH",
      "The wallet directory must be absolute.",
    );
    requireWallet(installationId === undefined || /^[0-9a-f-]{36}$/.test(installationId),
      "WALLET_RECOVERY_REQUIRED", "The installation identity is invalid.");
    if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
    requireWallet(
      existsSync(directory),
      "WALLET_NOT_INITIALIZED",
      "The wallet directory does not exist.",
    );
    const info = lstatSync(directory);
    requireWallet(
      info.isDirectory() && !info.isSymbolicLink(),
      "UNSAFE_STORAGE_PATH",
      "A private wallet directory is required.",
    );
    chmodSync(directory, 0o700);
    directory = realpathSync(directory);
    const lease = heldLease ?? acquireWalletWriter(directory);
    let connection: DatabaseSync | undefined;
    try {
      const path = join(directory, "wallet.sqlite");
      if (create) closeSync(openSync(path, "wx", 0o600));
      else
        requireWallet(
          existsSync(path),
          "WALLET_NOT_INITIALIZED",
          "The wallet database does not exist.",
        );
      privateFile(path);
      connection = new DatabaseSync(path);
      connection.exec(
        "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
      );
      const version = Number(connection.prepare("PRAGMA user_version").get()?.user_version);
      requireWallet(
        version === 0 || version === 1 || version === 2 || version === 3 || version === SCHEMA_VERSION || version === GENERAL_SOURCE_SCHEMA_VERSION,
        "SCHEMA_INCOMPATIBLE",
        "The wallet schema is not supported.",
      );
      if (version === 1) migrateTransport(connection, directory);
      if (version === 1 || version === 2) migrateResponseRetention(connection, directory);
      if (version >= 1 && version <= 3) migrateJournalAnchors(connection, directory);
      if (version === 0) {
        requireWallet(
          create,
          "WALLET_NOT_INITIALIZED",
          "An existing database cannot initialize a new schema.",
        );
        const count = Number(
          connection.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()?.n,
        );
        requireWallet(
          count === 0,
          "SCHEMA_INCOMPATIBLE",
          "An unrecognized database must not be overwritten.",
        );
        connection.exec("BEGIN IMMEDIATE");
        try {
          connection.exec(SCHEMA);
          if (freshSchema === GENERAL_SOURCE_SCHEMA_VERSION) connection.exec(GENERAL_SOURCE_SCHEMA);
          const put = connection.prepare("INSERT INTO wallet_metadata(name,value) VALUES(?,?)");
          put.run("installation_id", installationId ?? randomUUID());
          put.run("owner_id", recoveredOwnerId ?? randomUUID());
          put.run("management_epoch", randomUUID());
          put.run("revision", "0");
          put.run("trusted_time", "0");
          put.run("initialization_state", "PRISTINE");
          put.run("initialization_attempt", "");
          connection
            .prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)")
            .run(freshSchema, Math.floor(Date.now() / 1000));
          connection.exec(`PRAGMA user_version=${freshSchema}; COMMIT;`);
        } catch (error) {
          connection.exec("ROLLBACK");
          throw error;
        }
      }
      requireWallet(
        connection.prepare("PRAGMA quick_check").get()?.quick_check === "ok",
        "LEDGER_CORRUPT",
        "The wallet database failed its integrity check.",
      );
      markOpenedStore(connection, directory);
      if (create) markFreshStore(connection);
      return new WalletDatabase(connection, lease, directory);
    } catch (error) {
      connection?.close();
      lease.close();
      if (error instanceof WalletError) throw error;
      const code =
        typeof error === "object" && error !== null && "errcode" in error
          ? Number(error.errcode) & 255
          : 0;
      throw new WalletError(
        code === 5 || code === 6 ? "WALLET_WRITER_BUSY" : "WALLET_STORAGE_FAILED",
        "The wallet database could not be opened.",
      );
    }
  }
  /** The caller owns both service leases and the source writer for the entire snapshot. */
  async snapshotForRelocation(directory: string, migrationId: string): Promise<WalletDatabase> {
    requireWallet(/^[0-9a-f-]{36}$/.test(migrationId), "WALLET_RELOCATION_REQUIRED",
      "A relocation identity is required.");
    const lease = acquireWalletWriter(directory);
    const path = join(directory, "wallet.sqlite");
    const pending = join(directory, "snapshot-" + migrationId + ".sqlite");
    try {
      requireWallet(!existsSync(path), "WALLET_RELOCATION_REQUIRED", "A target wallet already exists.");
      if (existsSync(pending)) {
        const info = lstatSync(pending);
        requireWallet(info.isFile() && !info.isSymbolicLink(), "UNSAFE_STORAGE_PATH",
          "The pending wallet snapshot must be a regular file.");
        unlinkSync(pending);
      }
      closeSync(openSync(pending, "wx", 0o600));
      await backup(this.connection, pending);
      const fd = openSync(pending, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(pending, path);
      const parent = openSync(directory, "r");
      try { fsyncSync(parent); } finally { closeSync(parent); }
    } catch (error) { lease.close(); throw error; }
    return WalletDatabase.openFile(directory, false, undefined, lease);
  }

  issueInitialization(mode: "fresh" | "resume"): InitializationTicket {
    return issueInitialization(this.connection, this.directory, mode);
  }
  beginInitialization(ticket: InitializationTicket) {
    return beginInitialization(this.connection, this.directory, ticket);
  }
  finishInitialization(attempt: InitializationAttempt, commands: readonly SqlCommand[]): void {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      consumeInitializationAttempt(this.connection, this.directory, attempt);
      for (const command of commands)
        this.connection.prepare(command.sql).run(...command.parameters);
      this.connection
        .prepare("UPDATE wallet_metadata SET value='READY' WHERE name='initialization_state'")
        .run();
      verifyReadyInitialState(this.connection);
      this.connection.exec("COMMIT");
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }
  isReady(): boolean {
    return (
      this.connection
        .prepare("SELECT value FROM wallet_metadata WHERE name='initialization_state'")
        .get()?.value === "READY"
    );
  }
  transaction(commands: readonly SqlCommand[], expectedRevision?: number): void {
    requireWallet(!this.closed, "WALLET_CLOSED", "The wallet database is closed.");
    requireWallet(
      Array.isArray(commands) &&
        commands.length <= 100000 &&
        commands.every(
          (command) =>
            command && typeof command.sql === "string" && Array.isArray(command.parameters),
        ),
      "INVALID_TRANSACTION",
      "A finite statement batch is required.",
    );
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      if (expectedRevision !== undefined) {
        const revision = this.connection
          .prepare("SELECT value FROM wallet_metadata WHERE name='revision'")
          .get()?.value;
        requireWallet(
          Number(revision) === expectedRevision,
          "STATE_CONFLICT",
          "Wallet state changed before commit.",
        );
      }
      for (const command of commands)
        this.connection.prepare(command.sql).run(...command.parameters);
      this.connection.exec("COMMIT");
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.connection.close();
    } finally {
      this.lease.close();
    }
  }
}

export interface SqlCommand {
  sql: string;
  parameters: SQLInputValue[];
}
export class SqlBatch {
  readonly commands: SqlCommand[] = [];
  prepare(sql: string): { run: (...parameters: SQLInputValue[]) => void } {
    return {
      run: (...parameters) => {
        this.commands.push({ sql, parameters });
      },
    };
  }
  exec(sql: string): void {
    this.commands.push({ sql, parameters: [] });
  }
}
