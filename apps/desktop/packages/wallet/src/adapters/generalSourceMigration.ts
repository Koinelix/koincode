import { DatabaseSync } from "node:sqlite";
import { closeSync, fsyncSync, openSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonical } from "./canonical.js";
import { GENERAL_SOURCE_SCHEMA, SCHEMA } from "./schema.js";
import { requireWallet } from "../domain/errors.js";

/** Explicit, authenticated operation under the original writer. Opening a wallet never calls this. */
export function migrateGeneralSources(db: DatabaseSync, directory: string): { backupPath: string } {
  const expected = new DatabaseSync(":memory:");
  const schema = (value: DatabaseSync) => canonical(value.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all());
  try {
    expected.exec(SCHEMA);
    requireWallet(db.prepare("PRAGMA user_version").get()?.user_version === 4 && schema(db) === schema(expected),
      "SCHEMA_INCOMPATIBLE", "The source upgrade requires the original complete schema 4.");
  } finally { expected.close(); }
  requireWallet(db.prepare("SELECT value FROM wallet_metadata WHERE name='initialization_state'").get()?.value === "READY" &&
    db.prepare("PRAGMA quick_check").get()?.quick_check === "ok", "WALLET_RECOVERY_REQUIRED", "The original ready wallet is required.");
  const backupPath = join(directory, `pre-general-sources-${randomUUID()}.sqlite`);
  closeSync(openSync(backupPath, "wx", 0o600));
  db.prepare("VACUUM INTO ?").run(backupPath);
  for (const path of [backupPath, directory]) { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try { requireWallet(backup.prepare("PRAGMA quick_check").get()?.quick_check === "ok" && schema(backup) === schema(db),
    "WALLET_STORAGE_FAILED", "The consistent source-upgrade backup could not be verified."); }
  finally { backup.close(); }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(GENERAL_SOURCE_SCHEMA);
    db.prepare("INSERT INTO schema_migrations VALUES(5,?)").run(Math.floor(Date.now() / 1000));
    db.exec("PRAGMA user_version=5; COMMIT;");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { backupPath };
}
