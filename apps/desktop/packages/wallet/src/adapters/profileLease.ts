import {
  publishProfileRecord,
  readProfileBinding,
  recordExists,
  type ProfileBinding,
} from "./profileRecords.js";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { requireWallet, WalletError } from "../domain/errors.js";
export function acquireProfileLease(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  requireWallet(
    info.isDirectory() && !info.isSymbolicLink(),
    "UNSAFE_STORAGE_PATH",
    "The service lease directory must be private.",
  );
  chmodSync(directory, 0o700);
  const path = join(realpathSync(directory), "service-lease.sqlite");
  if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
  const file = lstatSync(path);
  requireWallet(
    file.isFile() && !file.isSymbolicLink(),
    "UNSAFE_STORAGE_PATH",
    "The service lease must be a regular file.",
  );
  chmodSync(path, 0o600);
  const database = new DatabaseSync(path);
  try {
    database.exec(
      "PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS service_guard(id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;",
    );
  } catch {
    database.close();
    throw new WalletError("WALLET_WRITER_BUSY", "The wallet service is already running.");
  }
  let closed = false;
  const marker = join(realpathSync(directory), "profile-registration.json"),
    current = join(realpathSync(directory), "profile-current.json");
  return {
    hasHistory(): boolean {
      return recordExists(marker) || recordExists(current);
    },
    readBinding(): ProfileBinding | null {
      return readProfileBinding(current) ?? readProfileBinding(marker);
    },
    bind(value: ProfileBinding): void {
      publishProfileRecord(directory, marker, value, false);
    },
    recoverBinding(value: ProfileBinding): void {
      requireWallet(
        !!value.recoveryId,
        "WALLET_RECOVERY_REQUIRED",
        "An explicit recovery identity is required.",
      );
      publishProfileRecord(directory, current, value, true);
    },
    close(): void {
      if (!closed) {
        closed = true;
        database.close();
      }
    },
  };
}
