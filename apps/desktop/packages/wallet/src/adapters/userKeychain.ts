import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ProtectedStore, ResponseSecretStore } from "../app/ports.js";
import { requireWallet } from "../domain/errors.js";
import { NativeKeychainStore } from "./keychain.js";
import { acquireProfileLease } from "./profileLease.js";

export const userStorageNamespaces = ["testnet", "m4-testnet", "mainnet", "general"] as const;
export type UserStorageNamespace = typeof userStorageNamespaces[number];
export const activeUserStorageNamespaces = ["m4-testnet", "mainnet", "general"] as const;
export const userStorageHelpers: Record<UserStorageNamespace, string> = {
  testnet: "keychain-helper", "m4-testnet": "keychain-helper-m4-testnet",
  mainnet: "keychain-helper-mainnet", general: "keychain-helper-general-wallet",
};
export const userStorageRoot = "user-store-root";
export const userStorageTransition = "user-store-transition";
export type ActiveUserStorageNamespace = typeof activeUserStorageNamespaces[number];
export type UserStorageActivation = { version: 2; state: "active"; generation: string; kind: "fresh" | "migrated";
  generations: Partial<Record<ActiveUserStorageNamespace, string>> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function physicalUserAccount(generation: string, account: string): string {
  requireWallet(uuid.test(generation) && /^[A-Za-z0-9:._-]{1,200}$/.test(account),
    "INVALID_SECRET_REFERENCE", "A valid generation and account are required.");
  return `r:${generation}:${account}`;
}
export function parseUserActivation(bytes: Uint8Array): UserStorageActivation {
  let value: UserStorageActivation | undefined;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { /* Reject corrupted roots. */ }
  requireWallet(value && Object.keys(value).sort().join() === "generation,generations,kind,state,version" &&
    value.version === 2 && value.state === "active" && uuid.test(value.generation) &&
    (value.kind === "fresh" || value.kind === "migrated") && value.generations &&
    typeof value.generations.general === "string" && uuid.test(value.generations.general) &&
    Object.values(value.generations).includes(value.generation) && Object.keys(value.generations).length > 0 && Object.entries(value.generations).every(([n, id]) =>
      activeUserStorageNamespaces.some(name => name === n) && typeof id === "string" && uuid.test(id)),
    "WALLET_STORAGE_RECOVERY_REQUIRED", "The protected storage activation is invalid.");
  return value;
}
export interface UserStorageBackend extends ProtectedStore {
  listLegacyAccounts(): Promise<string[]>;
  removePhysicalResponseSecret(account: string): Promise<void>;
  removeResponseFile(ref: string, fd: number): Promise<void>;
}
/** One activation record in the general service covers every payment namespace. */
export class UserStorageRegistry {
  constructor(readonly stores: Record<UserStorageNamespace, UserStorageBackend>,
    private readonly acquire: () => { close(): void }) {}
  async activation(): Promise<UserStorageActivation | null> {
    const bytes = await this.stores.general.get(userStorageRoot);
    try { return bytes === null ? null : parseUserActivation(bytes); }
    finally { bytes?.fill(0); }
  }
  async assertPristine(namespace: ActiveUserStorageNamespace, current: UserStorageActivation | null): Promise<void> {
    const targets: ActiveUserStorageNamespace[] = current?.generations.general ? [namespace] : [...new Set([namespace, "general" as const])];
    for (const payment of ["m4-testnet", "mainnet"] as const) {
      if (current?.generations[payment] || (current?.generations.general && payment !== namespace)) continue;
      const pending = await this.stores.general.get(`${userStorageTransition}:${payment}`);
      try { requireWallet(pending === null, "WALLET_STORAGE_MIGRATION_PENDING", "The original storage migration must finish first."); }
      finally { pending?.fill(0); }
    }
    for (const target of targets) requireWallet((await this.stores[target].listLegacyAccounts()).length === 0,
      "WALLET_STORAGE_MIGRATION_REQUIRED", "The original protected wallet requires explicit compatibility migration.");
  }
  async resolve(namespace: ActiveUserStorageNamespace, create: boolean): Promise<UserStorageActivation | null> {
    const current = await this.activation();
    if (current?.generations[namespace]) return current;
    if (!create) { await this.assertPristine(namespace, current); return null; }
    const lease = this.acquire();
    try {
      const existing = await this.activation(); if (existing?.generations[namespace]) return existing;
      await this.assertPristine(namespace, existing);
      const id = randomUUID();
      const activation: UserStorageActivation = { version: 2, state: "active", generation: id, kind: "fresh",
        generations: { ...existing?.generations, [namespace]: id, general: existing?.generations.general ?? id } };
      await this.stores.general.put(userStorageRoot, Buffer.from(JSON.stringify(activation)));
      const verified = await this.activation();
      requireWallet(verified?.generation === activation.generation, "WALLET_STORAGE_RECOVERY_REQUIRED", "Storage activation did not verify.");
      return verified;
    } finally { lease.close(); }
  }
  storage(namespace: UserStorageNamespace): ResponseSecretStore & { removeResponseFile(ref: string, fd: number): Promise<void> } {
    requireWallet(namespace !== "testnet", "WALLET_LEGACY_NAMESPACE_UNSUPPORTED", "The archived testnet store is retained outside this migration.");
    const backend = this.stores[namespace];
    return {
      get: async account => {
        physicalUserAccount("00000000-0000-0000-0000-000000000000", account);
        const root = await this.resolve(namespace, false);
        return root ? backend.get(physicalUserAccount(root.generations[namespace]!, account)) : null;
      },
      put: async (account, bytes) => {
        physicalUserAccount("00000000-0000-0000-0000-000000000000", account);
        const root = await this.resolve(namespace, true);
        await backend.put(physicalUserAccount(root!.generations[namespace]!, account), bytes);
      },
      removeResponseSecret: async account => {
        requireWallet(/^(?:http-blob|http-quarantine):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(account),
          "INVALID_SECRET_REFERENCE", "Only exact response secrets can be removed.");
        const root = await this.resolve(namespace, false);
        if (root) await backend.removePhysicalResponseSecret(physicalUserAccount(root.generations[namespace]!, account));
      },
      removeResponseFile: (ref, fd) => backend.removeResponseFile(ref, fd),
    };
  }
}
export function createUserStorageRegistry(helperDirectory: string): UserStorageRegistry {
  requireWallet(basename(helperDirectory) === "user-v2", "PROTECTED_STORAGE_UPGRADE_REQUIRED", "The v2 helper directory is required.");
  const stores = Object.fromEntries(userStorageNamespaces.map(namespace =>
    [namespace, new NativeKeychainStore(join(helperDirectory, userStorageHelpers[namespace]), "user-v2")])) as Record<UserStorageNamespace, NativeKeychainStore>;
  return new UserStorageRegistry(stores, () => acquireProfileLease(join(homedir(), ".koincode/wallet/user-storage")));
}
export function createUserKeychainStore(helper: string) {
  const namespace = userStorageNamespaces.find(name => userStorageHelpers[name] === basename(helper));
  requireWallet(namespace, "INVALID_REQUEST_CONFIGURATION", "Unknown wallet protection namespace.");
  return createUserStorageRegistry(dirname(helper)).storage(namespace);
}

/** Existing legacy entrypoints retain their protocol; there is no error-driven fallback. */
export function createLocalKeychainStore(helper: string) {
  return basename(dirname(helper)) === "user-v2" ? createUserKeychainStore(helper) : new NativeKeychainStore(helper);
}
