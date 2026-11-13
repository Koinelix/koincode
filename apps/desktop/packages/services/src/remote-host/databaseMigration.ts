import { DatabaseSync, backup } from "node:sqlite";
import { open, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RemoteHostError } from "@fcode/shared";
import { protectRemoteHostPath } from "./privatePaths.js";

/** Preserve a consistent private v1 snapshot before publishing the v2 document contract. */
export async function migrateRemoteHostV1(database: DatabaseSync, directory: string, copy: typeof backup = backup): Promise<string> {
  const ownerId = database.prepare("SELECT value FROM remote_metadata WHERE name = 'owner_id'").get()?.value;
  if (typeof ownerId !== "string" || !ownerId) throw new RemoteHostError("storage_corrupt", "The migration source has no valid local owner.", "storage");
  const name = `remote-hosts.pre-v2-${randomUUID()}`;
  const temporary = join(directory, `${name}.partial.sqlite`); const published = join(directory, `${name}.sqlite`);
  let verified = false;
  try {
    const handle = await open(temporary, "wx", 0o600); await handle.close(); await protectRemoteHostPath(temporary, false);
    await copy(database, temporary);
    await protectRemoteHostPath(temporary, false);
    const snapshot = new DatabaseSync(temporary);
    try {
      snapshot.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      if (snapshot.prepare("PRAGMA journal_mode = DELETE").get()?.journal_mode !== "delete") {
        throw new RemoteHostError("storage_corrupt", "The migration backup is not self-contained.", "storage");
      }
      if (snapshot.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok" ||
        snapshot.prepare("PRAGMA user_version").get()?.user_version !== 1 ||
        snapshot.prepare("SELECT value FROM remote_metadata WHERE name = 'owner_id'").get()?.value !== ownerId) {
        throw new RemoteHostError("storage_corrupt", "The private migration backup could not be verified.", "storage");
      }
    } finally { snapshot.close(); }
    // An exclusive link publishes the verified backup without replacing any existing file.
    await link(temporary, published); verified = true; await unlink(temporary); await protectRemoteHostPath(published, false);
  } catch {
    if (!verified) await unlink(temporary).catch(() => {});
    throw new RemoteHostError("storage_corrupt", "The private migration backup failed. The original database was not upgraded.", "storage");
  }
  database.exec("BEGIN IMMEDIATE");
  try { database.exec("PRAGMA user_version = 2; COMMIT"); }
  catch (error) { try { database.exec("ROLLBACK"); } catch { /* Preserve the original migration error. */ } throw error; }
  return published;
}
