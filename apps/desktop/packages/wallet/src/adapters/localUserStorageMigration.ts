import { homedir } from "node:os";
import { join } from "node:path";
import type { ProtectedStore } from "../app/ports.js";
import { acquireProfileLease } from "./profileLease.js";
import { NativeKeychainStore } from "./keychain.js";
import { createUserStorageRegistry, userStorageHelpers, userStorageNamespaces, type UserStorageNamespace } from "./userKeychain.js";
import { UserStorageMigration, type UserStorageMigrationPlan } from "./userStorageMigration.js";
import { freezeUserStorage } from "./userStorageSnapshot.js";

/** Trusted maintenance only. Caller must stop the wallet utility before planning or executing. */
export async function localUserStorageMigration(helperDirectory: string, payment: "m4-testnet" | "mainnet", approved?: UserStorageMigrationPlan, progress?: () => void, assertCurrent?: () => void) {
  const lease = acquireProfileLease(join(homedir(), ".koincode/wallet/user-storage"));
  try {
    const registry = createUserStorageRegistry(helperDirectory);
    const legacy = Object.fromEntries(userStorageNamespaces.map(namespace =>
      [namespace, new NativeKeychainStore(join(helperDirectory, userStorageHelpers[namespace]), "legacy-v2")])) as unknown as Record<UserStorageNamespace, ProtectedStore>;
    const migration = new UserStorageMigration(registry, domains => freezeUserStorage(legacy, domains), payment, progress, assertCurrent);
    if (approved) return { status: "active" as const, activation: await migration.execute(approved) };
    return { status: "planned" as const, plan: await migration.plan() };
  } finally { lease.close(); }
}
