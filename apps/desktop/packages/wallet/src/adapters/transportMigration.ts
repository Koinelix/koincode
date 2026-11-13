import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonical } from "./canonical.js";
import { SCHEMA_V1, TRANSPORT_SCHEMA } from "./schema.js";
import { requireWallet } from "../domain/errors.js";
export function migrateTransport(db: DatabaseSync, directory: string): void {
  const expected = new DatabaseSync(":memory:");
  const schema = (c: DatabaseSync) =>
    canonical(
      c.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    );
  try {
    expected.exec(SCHEMA_V1);
    requireWallet(
      schema(db) === schema(expected),
      "SCHEMA_INCOMPATIBLE",
      "The legacy wallet schema is not authoritative.",
    );
  } finally {
    expected.close();
  }
  requireWallet(
    db.prepare("SELECT value FROM wallet_metadata WHERE name='initialization_state'").get()
      ?.value === "READY",
    "WALLET_RECOVERY_REQUIRED",
    "Legacy pending setup must be completed before upgrade.",
  );
  const backup = join(directory, "pre-m3-" + randomUUID() + ".sqlite");
  db.prepare("VACUUM INTO ?").run(backup);
  chmodSync(backup, 0o600);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(TRANSPORT_SCHEMA);
    db.prepare("INSERT INTO schema_migrations VALUES(2,?)").run(Math.floor(Date.now() / 1000));
    db.exec("PRAGMA user_version=2; COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
