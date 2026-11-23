import { closeSync, fsyncSync, mkdirSync, openSync, type BigIntStats, type Stats } from "node:fs";
import { windowsNativeSync } from "./windowsNative.js";

/** POSIX mode checks remain unchanged; Windows checks the opened object's DACL. */
export function privatePermissions(info: Pick<Stats, "mode"> | Pick<BigIntStats, "mode">, path: string, directory = false): boolean {
  if (process.platform !== "win32") return typeof info.mode === "bigint" ? (info.mode & 0o077n) === 0n : (info.mode & 0o077) === 0;
  try { windowsNativeSync(["check", path, directory ? "directory" : "file"]); return true; }
  catch { return false; }
}
export function createPrivateDirectory(path: string): void {
  if (process.platform === "win32") windowsNativeSync(["directory", path]);
  else mkdirSync(path, { recursive: true, mode: 0o700 });
}
export function syncPrivateDirectory(path: string): void {
  if (process.platform === "win32") {
    // Windows names are published by MoveFileExW with WRITE_THROUGH; file data
    // uses FlushFileBuffers. Opening a directory with Node is not a barrier.
    windowsNativeSync(["check", path, "directory"]);
    return;
  }
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function createWindowsPrivateFile(path: string): void { windowsNativeSync(["touch", path]); }
