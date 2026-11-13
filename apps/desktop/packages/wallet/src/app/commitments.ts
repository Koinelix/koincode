import type { StateCommitment, WalletState } from "./state.js";
import { WalletError } from "../domain/errors.js";
export interface RootRegistration {
  version: 1;
  installationId: string;
  ownerId: string;
  storageBinding: string;
  attemptId: string;
  phase: "REGISTERED" | "READY";
  initialCommitment: StateCommitment;
}
export function sameCommitment(a: StateCommitment | null, b: StateCommitment | null): boolean {
  if (!a || !b) return false;
  const keys = Object.keys(a) as (keyof StateCommitment)[];
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  );
}
export function rootMatches(
  root: RootRegistration | null,
  state: WalletState,
  storageBinding: string,
): boolean {
  return (
    !!root &&
    root.version === 1 &&
    root.installationId === state.installationId &&
    root.ownerId === state.ownerId &&
    root.storageBinding === storageBinding &&
    root.attemptId === state.initializationAttempt &&
    root.initialCommitment?.installationId === root.installationId &&
    root.initialCommitment?.ownerId === root.ownerId &&
    root.initialCommitment?.storageBinding === root.storageBinding &&
    root.initialCommitment?.initializationAttempt === root.attemptId &&
    root.initialCommitment?.revision === 1 &&
    root.initialCommitment?.ledgerHead === "0".repeat(64)
  );
}
export async function protectedJson<T>(
  store: { get(account: string): Promise<Uint8Array | null> },
  account: string,
): Promise<T | null> {
  const bytes = await store.get(account);
  if (!bytes) return null;
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
  } catch {
    throw new WalletError("WALLET_RECOVERY_REQUIRED", "A protected wallet record is invalid.");
  } finally {
    bytes.fill(0);
  }
}
