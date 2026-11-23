import { execFile, execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { WalletError, requireWallet } from "../domain/errors.js";

let helper: string | undefined;
const names = new Set(["keychain-helper", "keychain-helper-mainnet", "keychain-helper-m4-testnet", "keychain-helper-general-wallet"]);
export function nativeHelperBasename(path: string): string {
  const name = basename(path);
  return process.platform === "win32" && name.endsWith(".exe") ? name.slice(0, -4) : name;
}
export function nativeHelperFilename(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}
export function configureWindowsNative(path: string): void {
  if (process.platform !== "win32") return;
  requireWallet(isAbsolute(path) && basename(dirname(path)) === "user-v2" && names.has(nativeHelperBasename(path)) && path.endsWith(".exe"),
    "PROTECTED_STORAGE_UNAVAILABLE", "The Windows wallet native resource is unavailable.");
  const info = lstatSync(path);
  requireWallet(info.isFile() && !info.isSymbolicLink(), "PROTECTED_STORAGE_UNAVAILABLE", "The Windows wallet resource is not a regular executable.");
  const selected = join(dirname(path), "keychain-helper.exe");
  requireWallet(helper === undefined || helper === selected, "PROTECTED_STORAGE_UNAVAILABLE", "The Windows wallet native owner cannot change.");
  helper = selected;
  windowsNativeSync(["executable", selected]);
}
export function windowsNativeHelper(): string {
  requireWallet(process.platform === "win32" && helper, "PROTECTED_STORAGE_UNAVAILABLE", "The Windows wallet native owner is unavailable.");
  return helper;
}
export function windowsNativeEnvironment(): NodeJS.ProcessEnv {
  return { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}) };
}
function failure(status: unknown): WalletError {
  return new WalletError(status === 78 ? "PROTECTED_STORAGE_POLICY_INVALID" : "PROTECTED_STORAGE_UNAVAILABLE",
    "Windows-protected wallet storage is unavailable.");
}
export function windowsNativeSync(args: string[]): Buffer {
  try {
    return execFileSync(windowsNativeHelper(), args, { encoding: "buffer", timeout: 11000, maxBuffer: 1114112,
      windowsHide: true, env: windowsNativeEnvironment(), stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) { throw failure((error as { status?: unknown }).status); }
}
export function windowsNativeExchange(args: string[], value?: Uint8Array): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const child = execFile(windowsNativeHelper(), args[0] === "put" && value ? [...args, String(value.length)] : args, { encoding: "buffer", timeout: 11000,
      maxBuffer: 1114112, windowsHide: true, env: windowsNativeEnvironment() }, (error, stdout) => {
      if (!error) { const value = new Uint8Array(stdout); stdout.fill(0); resolve(value); }
      else if (args[0] === "get" && error.code === 44) resolve(null);
      else { stdout.fill(0); reject(failure(error.code)); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(value);
  });
}
