import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateGeneralState, type GeneralWalletState } from "../app/generalState.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical, digest } from "./canonical.js";
import { acquireWalletWriter } from "./database.js";
import { preflightGeneralDatabase } from "./generalStoragePreflight.js";
import type { GeneralStateRepository } from "./generalGuardedState.js";

const MAX_STATE = 512 * 1024;

/** Opens only the independent general-wallet directory selected by its trusted local owner. */
export class SqliteGeneralStateRepository implements GeneralStateRepository {
  private closed = false;
  private constructor(private readonly connection: DatabaseSync, private readonly lease: DatabaseSync,
    private readonly path: string, private readonly device: number, private readonly inode: number) {}

  static open(directory: string, mode: "create" | "open"): SqliteGeneralStateRepository {
    requireWallet(isAbsolute(directory) && resolve(directory) === directory, "GENERAL_STORE_UNAVAILABLE", "Invalid general wallet directory.");
    if (mode === "create" && !existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    requireWallet(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 &&
      (typeof process.getuid !== "function" || info.uid === process.getuid()),
    "GENERAL_STORE_UNAVAILABLE", "The general wallet directory is not private.");
    const realDirectory = realpathSync(directory);
    requireWallet(realDirectory === directory, "GENERAL_STORE_UNAVAILABLE", "The general wallet directory cannot be redirected.");
    const path = join(realDirectory, "general-wallet.sqlite");
    const before = preflightGeneralDatabase(path, mode, "GENERAL_STORE_UNAVAILABLE");
    const lease = acquireWalletWriter(realDirectory);
    let connection: DatabaseSync | undefined;
    try {
      if (mode === "create") closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
      const file = preflightGeneralDatabase(path, "open", "GENERAL_STORE_UNAVAILABLE")!;
      requireWallet(!before || file.dev === before.dev && file.ino === before.ino,
        "GENERAL_STORE_UNAVAILABLE", "The general wallet file identity changed.");
      connection = new DatabaseSync(path);
      connection.exec("PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      const version = Number(connection.prepare("PRAGMA user_version").get()?.user_version);
      if (mode === "create") {
        requireWallet(version === 0 && Number(connection.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()?.n) === 0,
          "GENERAL_STORE_UNAVAILABLE", "The general wallet file is not new.");
        connection.exec("BEGIN IMMEDIATE; CREATE TABLE general_state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, state_json TEXT NOT NULL); PRAGMA user_version=1; COMMIT;");
      } else requireWallet(version === 1, "GENERAL_STORE_UNAVAILABLE", "The general wallet schema is incompatible.");
      return new SqliteGeneralStateRepository(connection, lease, path, file.dev, file.ino);
    } catch (error) {
      connection?.close(); lease.close();
      if (error instanceof WalletError) throw error;
      throw new WalletError("GENERAL_STORE_UNAVAILABLE", "The general wallet database cannot be opened.");
    }
  }

  private verifyFile(): void {
    try {
      const current = lstatSync(this.path);
      requireWallet(!this.closed && current.isFile() && !current.isSymbolicLink() && current.dev === this.device && current.ino === this.inode &&
        (current.mode & 0o077) === 0 && (typeof process.getuid !== "function" || current.uid === process.getuid()),
      "GENERAL_STORE_UNAVAILABLE", "The general wallet database identity changed.");
    } catch { throw new WalletError("GENERAL_STORE_UNAVAILABLE", "The general wallet database identity changed."); }
  }

  read(): GeneralWalletState | null {
    this.verifyFile();
    const row = this.connection.prepare("SELECT revision, state_json FROM general_state WHERE id=1").get();
    if (!row) return null;
    requireWallet(typeof row.state_json === "string" && Buffer.byteLength(row.state_json) <= MAX_STATE,
      "GENERAL_STORE_UNAVAILABLE", "The general wallet projection is invalid.");
    try {
      const parsed: unknown = JSON.parse(row.state_json);
      const state = validateGeneralState(parsed);
      requireWallet(canonical(parsed) === row.state_json && Number(row.revision) === state.revision,
        "GENERAL_STORE_UNAVAILABLE", "The general wallet projection is invalid.");
      return state;
    } catch { throw new WalletError("GENERAL_STORE_UNAVAILABLE", "The general wallet projection is invalid."); }
  }

  write(expected: GeneralWalletState | null, next: GeneralWalletState): void {
    this.verifyFile();
    const value = validateGeneralState(next), serialized = canonical(value);
    requireWallet(Buffer.byteLength(serialized) <= MAX_STATE, "GENERAL_STORE_UNAVAILABLE", "The wallet projection exceeds its capacity.");
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const current = this.read();
      requireWallet(expected === null ? current === null : current !== null && digest(current) === digest(expected),
        "GENERAL_STORE_UNAVAILABLE", "The wallet projection changed unexpectedly.");
      this.connection.prepare("INSERT INTO general_state(id,revision,state_json) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json")
        .run(value.revision, serialized);
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
