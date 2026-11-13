import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { REMOTE_HOST_LIMITS, RemoteHostError } from "@fcode/shared";
import { createRemoteHostPrivateDirectory, protectRemoteHostPath } from "./privatePaths.js";

/** SQLite's OS-backed exclusive lock releases on process exit, including an abrupt broker crash. */
export async function acquireRemoteBrokerLease(root: string): Promise<() => Promise<void>> {
  await createRemoteHostPrivateDirectory(root);
  const path = join(root, "broker-lease.sqlite");
  const lease = new DatabaseSync(path);
  try {
    lease.exec(`PRAGMA busy_timeout = ${REMOTE_HOST_LIMITS.busyTimeoutMs}; PRAGMA locking_mode = EXCLUSIVE;
      BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS broker_lease (id INTEGER PRIMARY KEY CHECK(id = 1)) STRICT;
      INSERT OR IGNORE INTO broker_lease(id) VALUES (1); COMMIT;`);
    await protectRemoteHostPath(path, false);
  } catch {
    lease.close();
    throw new RemoteHostError("storage_busy", "Another broker owns this data root, or its ownership database is unavailable.", "storage");
  }
  let released = false;
  return async () => { if (!released) { released = true; lease.close(); } };
}
