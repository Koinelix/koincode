import { DatabaseSync } from "node:sqlite";
import { closeSync, fsyncSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonical } from "./canonical.js";
import { SCHEMA_V2, RETENTION_SCHEMA } from "./schema.js";
import { requireWallet } from "../domain/errors.js";

export function migrateResponseRetention(db: DatabaseSync, directory: string): void {
  const expected = new DatabaseSync(":memory:");
  const schema = (value: DatabaseSync) => canonical(
    value.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
  );
  try {
    expected.exec(SCHEMA_V2);
    requireWallet(db.prepare("PRAGMA user_version").get()?.user_version === 2 &&
      schema(db) === schema(expected), "SCHEMA_INCOMPATIBLE",
    "The response retention upgrade requires the authoritative schema 2.");
  } finally { expected.close(); }
  requireWallet(db.prepare("SELECT value FROM wallet_metadata WHERE name='initialization_state'").get()?.value === "READY",
    "WALLET_RECOVERY_REQUIRED", "Pending wallet setup must finish before the retention upgrade.");
  const backup = join(directory, "pre-response-retention-" + randomUUID() + ".sqlite");
  const fd = openSync(backup, "wx", 0o600);
  closeSync(fd);
  db.prepare("VACUUM INTO ?").run(backup);
  for (const path of [backup, directory]) {
    const descriptor = openSync(path, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(RETENTION_SCHEMA);
    db.prepare("INSERT INTO schema_migrations VALUES(3,?)").run(Math.floor(Date.now() / 1000));
    db.exec("PRAGMA user_version=3; COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
