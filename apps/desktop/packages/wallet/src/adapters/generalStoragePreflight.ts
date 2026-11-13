import { lstatSync } from "node:fs";
import { WalletError, requireWallet } from "../domain/errors.js";

type ErrorCode = "GENERAL_STORE_UNAVAILABLE" | "SIGNING_CONTINUITY_UNKNOWN";
type FileIdentity = { dev: number; ino: number };

/** Metadata inspection only; it does not open the SQLite file or establish a trusted lease. */
export function preflightGeneralDatabase(path: string, mode: "create" | "open", code: ErrorCode): FileIdentity | null {
  try {
    let file;
    try { file = lstatSync(path); }
    catch (error) {
      if (mode === "create" && error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    requireWallet(mode === "open" && file.isFile() && !file.isSymbolicLink() && (file.mode & 0o077) === 0 &&
      (typeof process.getuid !== "function" || file.uid === process.getuid()), code, "The general wallet file is unavailable.");
    return { dev: file.dev, ino: file.ino };
  } catch {
    throw new WalletError(code, "The general wallet file is unavailable.");
  }
}
