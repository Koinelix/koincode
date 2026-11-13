import { basename, dirname } from "node:path";
import type { ProtectedStore } from "../app/ports.js";
import { requireWallet } from "../domain/errors.js";
import { NativeKeychainStore } from "./keychain.js";
import { createUserKeychainStore } from "./userKeychain.js";

/** This separate helper is the only Keychain service usable by the general-wallet owner. */
export function createGeneralKeychainStore(helper: string): ProtectedStore {
  requireWallet(typeof helper === "string" && basename(helper) === "keychain-helper-general-wallet",
    "GENERAL_STORE_UNAVAILABLE", "The independent general wallet protection backend is unavailable.");
  const store = basename(dirname(helper)) === "user-v2" ? createUserKeychainStore(helper) : new NativeKeychainStore(helper, true);
  return { get: (account) => store.get(account), put: (account, value) => store.put(account, value) };
}

/** Same independent service, with a distinct local-basic account prefix. */
export function createLocalGeneralProtection(helper: string, injected?: ProtectedStore): ProtectedStore {
  const store = injected ?? createGeneralKeychainStore(helper);
  return { get: (account) => store.get(`local-v1:${account}`), put: (account, bytes) => store.put(`local-v1:${account}`, bytes) };
}
