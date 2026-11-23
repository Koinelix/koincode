import type { UserStorageBackend } from "./userStorageBackend.js";
import { configureWindowsNative, windowsNativeExchange } from "./windowsNative.js";
import { requireWallet, WalletError } from "../domain/errors.js";

/** DPAPI protects the existing registry's values, not a second wallet or ledger. */
export class WindowsProtectedStore implements UserStorageBackend {
  constructor(helper: string, private readonly namespace: string) { configureWindowsNative(helper); }
  private exchange(operation: string, account: string, value?: Uint8Array) {
    requireWallet(/^[A-Za-z0-9:._-]{1,256}$/.test(account) &&
      (value === undefined || value.length > 0 && value.length <= 1048576),
    "INVALID_SECRET_REFERENCE", "The protected storage reference or value is invalid.");
    return windowsNativeExchange([operation, this.namespace, account], value);
  }
  get(account: string) { return this.exchange("get", account); }
  async put(account: string, value: Uint8Array): Promise<void> { await this.exchange("put", account, value); }
  async listLegacyAccounts(): Promise<string[]> {
    const bytes = await this.exchange("legacy", "metadata");
    try {
      const inventory: unknown = JSON.parse(Buffer.from(bytes ?? []).toString("utf8"));
      requireWallet(Array.isArray(inventory) && inventory.length === 0, "WALLET_STORAGE_RECOVERY_REQUIRED",
        "Existing Windows protected records cannot be activated as a fresh wallet.");
    } finally { bytes?.fill(0); }
    return [];
  }
  async removePhysicalResponseSecret(account: string): Promise<void> {
    requireWallet(/^r:[0-9a-f-]{36}:(?:http-blob|http-quarantine):[0-9a-f-]{36}$/.test(account),
      "INVALID_SECRET_REFERENCE", "Only a generation-bound response secret may be removed.");
    await this.exchange("remove", account);
  }
  async removeResponseFile(): Promise<void> {
    throw new WalletError("RESPONSE_STORAGE_UNAVAILABLE", "Windows response cleanup requires its bound native directory adapter.");
  }
}
