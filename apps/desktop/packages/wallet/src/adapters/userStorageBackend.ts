import type { ProtectedStore } from "../app/ports.js";

export interface UserStorageBackend extends ProtectedStore {
  listLegacyAccounts(): Promise<string[]>;
  removePhysicalResponseSecret(account: string): Promise<void>;
  removeResponseFile(ref: string, fd: number): Promise<void>;
}
