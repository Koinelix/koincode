import type { ProtectedStore } from "../app/ports.js";
import type { StateCommitment } from "../app/state.js";
import { protectedJson, type RootRegistration } from "../app/commitments.js";
import { requireWallet } from "../domain/errors.js";
import type { ProfileBinding, ProtectedProfile } from "./profileRecords.js";
import { canonical } from "./canonical.js";

export const RELOCATION_ACCOUNT = "wallet-directory-relocation";
export const RELOCATION_STAGES = ["PREPARED", "COPIED", "ANCHORED", "SWITCHED", "COMPLETE"] as const;
export interface RelocationJournal {
  version: 1;
  migrationId: string;
  stage: typeof RELOCATION_STAGES[number];
  source: string;
  sourceService: string;
  target: string;
  targetService: string;
  profile: ProtectedProfile;
  binding: ProfileBinding;
  root: RootRegistration;
  commitment: StateCommitment;
  databaseDigest: string;
  blobsDigest: string;
}

export async function readRelocationJournal(protection: ProtectedStore) {
  const journal = await protectedJson<RelocationJournal>(protection, RELOCATION_ACCOUNT);
  if (journal) requireWallet(journal.version === 1 &&
    /^[0-9a-f-]{36}$/.test(journal.migrationId) && RELOCATION_STAGES.includes(journal.stage),
  "WALLET_RELOCATION_REQUIRED", "The protected relocation journal is invalid.");
  return journal;
}

export async function assertNoPendingRelocation(protection: ProtectedStore) {
  const journal = await readRelocationJournal(protection);
  requireWallet(!journal || journal.stage === "COMPLETE", "WALLET_RELOCATION_REQUIRED",
    "Finish the pending wallet directory relocation before opening the wallet.");
}

/** Unknown write outcomes must be read back; no caller may infer persistence from an exception. */
export async function publishProtectedRecord(
  protection: ProtectedStore, account: string, expected: unknown, allowed: readonly unknown[],
) {
  const current = await protectedJson<unknown>(protection, account);
  if (canonical(current) === canonical(expected)) return;
  requireWallet(allowed.some(value => canonical(value) === canonical(current)),
    "WALLET_RELOCATION_REQUIRED", "A protected relocation record changed unexpectedly.");
  const bytes = Buffer.from(JSON.stringify(expected));
  try {
    try { await protection.put(account, bytes); }
    catch (error) {
      if (canonical(await protectedJson(protection, account)) !== canonical(expected)) throw error;
    }
    requireWallet(canonical(await protectedJson(protection, account)) === canonical(expected),
      "WALLET_RELOCATION_REQUIRED", "The protected relocation write could not be verified.");
  } finally { bytes.fill(0); }
}
