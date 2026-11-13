import { execFile, spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { WalletError, requireWallet } from "../domain/errors.js";
import type { ResponseSecretStore } from "../app/ports.js";

export class NativeKeychainStore implements ResponseSecretStore {
  constructor(private readonly helper: string, private readonly noninteractive: boolean | "user-v2" | "legacy-v2" = false) {
    requireWallet(
      process.platform === "darwin" && isAbsolute(helper),
      "PROTECTED_STORAGE_UNAVAILABLE",
      "The native Keychain backend is required.",
    );
    const info = lstatSync(helper);
    requireWallet(
      info.isFile() && !info.isSymbolicLink() && (info.mode & 0o022) === 0,
      "PROTECTED_STORAGE_UNAVAILABLE",
      "The Keychain helper is not a protected executable.",
    );
  }
  private exchange(
    operation: "get" | "put" | "remove-response-secret" | "list-legacy",
    account: string,
    value?: Uint8Array,
  ): Promise<Uint8Array | null> {
    requireWallet(
      (this.noninteractive === "user-v2" ? /^[A-Za-z0-9:._-]{1,256}$/ : /^[A-Za-z0-9:._-]{1,200}$/).test(account),
      "INVALID_SECRET_REFERENCE",
      "Invalid protected storage account.",
    );
    requireWallet(
      !value || (value.byteLength > 0 && value.byteLength <= 1048576),
      "INVALID_SECRET_VALUE",
      "Protected storage value exceeds its bounds.",
    );
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.helper,
        [operation, account, ...(this.noninteractive === "user-v2" ? ["--user-store-v2"] : this.noninteractive === "legacy-v2" ? ["--legacy-reader-v2"] : this.noninteractive ? ["--noninteractive"] : [])],
        {
          encoding: "buffer",
          timeout: 11000,
          maxBuffer: 1048576,
          windowsHide: true,
          env: { PATH: "/usr/bin:/bin" },
        },
        (error, stdout) => {
          if (!error && (operation !== "remove-response-secret" || stdout.length === 0))
            resolve(new Uint8Array(stdout));
          else if (operation === "get" && error?.code === 44) resolve(null);
          else
            reject(
              new WalletError(
                this.noninteractive && error?.code === 64 ? "PROTECTED_STORAGE_UPGRADE_REQUIRED" : error?.code === 79 ? "WALLET_LEGACY_READER_UNAVAILABLE" : error?.code === 78 ? "PROTECTED_STORAGE_POLICY_INVALID" : error?.code === 77 ? "PROTECTED_STORAGE_AUTH_REQUIRED"
                  : error?.killed || error?.signal === "SIGALRM" ? "PROTECTED_STORAGE_TIMEOUT" : "PROTECTED_STORAGE_UNAVAILABLE",
                "System-protected wallet storage is unavailable.",
              ),
            );
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(value);
    });
  }
  async listLegacyAccounts(): Promise<string[]> {
    requireWallet(this.noninteractive === "user-v2", "PROTECTED_STORAGE_UPGRADE_REQUIRED", "The v2 metadata protocol is required.");
    const bytes = await this.exchange("list-legacy", "metadata");
    try {
      const names: unknown = JSON.parse(Buffer.from(bytes ?? []).toString("utf8"));
      requireWallet(Array.isArray(names) && names.length <= 4096 &&
        names.every((name) => typeof name === "string" && /^[A-Za-z0-9:._-]{1,200}$/.test(name)) &&
        new Set(names).size === names.length, "PROTECTED_STORAGE_UNAVAILABLE", "Invalid legacy storage inventory.");
      return names as string[];
    } finally { bytes?.fill(0); }
  }
  async removePhysicalResponseSecret(account: string): Promise<void> {
    requireWallet(this.noninteractive === "user-v2" &&
      /^r:[0-9a-f-]{36}:(?:http-blob|http-quarantine):[0-9a-f-]{36}$/.test(account),
      "INVALID_SECRET_REFERENCE", "Only generation-bound response secrets may be removed.");
    await this.exchange("remove-response-secret", account);
  }
  async get(account: string): Promise<Uint8Array | null> {
    return this.exchange("get", account);
  }
  async put(account: string, value: Uint8Array): Promise<void> {
    await this.exchange("put", account, value);
  }
  async removeResponseSecret(account: string): Promise<void> {
    requireWallet(
      typeof account === "string" &&
        /^(?:http-blob|http-quarantine):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(account),
      "INVALID_SECRET_REFERENCE",
      "Only exact protected response references can be removed.",
    );
    await this.exchange("remove-response-secret", account);
  }
  /** Internal file cleanup uses an inherited directory handle, never a caller-supplied path. */
  async removeResponseFile(ref: string, directoryFd: number): Promise<void> {
    requireWallet(typeof ref === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref) &&
      Number.isSafeInteger(directoryFd) && directoryFd >= 0,
    "INVALID_SECRET_REFERENCE", "An exact response reference and directory handle are required.");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.helper, ["remove-response-file", ref], {
        stdio: ["ignore", "pipe", "ignore", directoryFd], env: { PATH: "/usr/bin:/bin" },
      });
      let output = false, expired = false;
      const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 11000);
      const fail = () => reject(new WalletError("PROTECTED_STORAGE_UNAVAILABLE",
        "System-protected response cleanup is unavailable."));
      child.stdout?.on("data", () => { output = true; child.kill("SIGKILL"); });
      child.once("error", () => { clearTimeout(timer); fail(); });
      child.once("close", code => {
        clearTimeout(timer);
        if (code === 0 && !output && !expired) resolve(); else fail();
      });
    });
  }
}
