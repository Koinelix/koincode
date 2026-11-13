import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { requireWallet, WalletError } from "../domain/errors.js";
export interface ProfileBinding {
  directory: string;
  installationId: string;
  ownerId: string;
  recoveryId?: string;
}
export interface ProtectedProfile extends ProfileBinding {
  version: 1;
  phase: "REGISTERED" | "RECOVERING" | "READY";
  recovery?: { recoveryId: string; backupDigest: string; previous: ProfileBinding | null };
}
export function recordExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export function readProfileBinding(path: string): ProfileBinding | null {
  if (!recordExists(path)) return null;
  const info = lstatSync(path);
  requireWallet(
    info.isFile() && !info.isSymbolicLink() && info.size <= 16384,
    "WALLET_RECOVERY_REQUIRED",
    "The service profile registration is invalid.",
  );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const value = JSON.parse(readFileSync(fd, "utf8")) as ProfileBinding;
    requireWallet(
      value &&
        typeof value.directory === "string" &&
        typeof value.installationId === "string" &&
        typeof value.ownerId === "string" &&
        (value.recoveryId === undefined || /^[0-9a-f-]{36}$/.test(value.recoveryId)),
      "WALLET_RECOVERY_REQUIRED",
      "The service profile registration is incomplete.",
    );
    return value;
  } catch {
    throw new WalletError(
      "WALLET_RECOVERY_REQUIRED",
      "The service profile registration cannot be parsed.",
    );
  } finally {
    closeSync(fd);
  }
}
export function publishProfileRecord(
  directory: string,
  path: string,
  value: ProfileBinding,
  replace: boolean,
): void {
  const pending = join(directory, "profile-registration." + randomUUID() + ".pending");
  let fd: number | null = openSync(pending, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (replace) renameSync(pending, path);
    else linkSync(pending, path);
    const parent = openSync(directory, "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(pending)) unlinkSync(pending);
  }
}
