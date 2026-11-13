import { randomInt } from "node:crypto";
import type { ProtectedStore } from "../app/ports.js";
import { transitionGeneralSetup, type SecretAdmission } from "../domain/generalSetup.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import type { GeneralGuardedState } from "./generalGuardedState.js";
import type { GeneralSecretJob } from "./generalSecretCrypto.js";

/** One substage of the original coordinator, with its same signal, protected
 * state owner and worker. No independent queue, authentication or accepted state. */
export async function confirmGeneralSetupBackup(input: {
  state: GeneralGuardedState; protection: ProtectedStore; setupId: string; words: string[]; signal: AbortSignal;
  admission(): void; secretAdmission?(): SecretAdmission; crypto(job: GeneralSecretJob, signal?: AbortSignal): Promise<unknown>;
}): Promise<boolean> {
  const { state, setupId, signal } = input;
  const snapshot = state.snapshot(), setup = snapshot.setups.find((item) => item.id === setupId);
  const source = snapshot.sources.find((item) => item.setupId === setupId);
  requireWallet(setup?.mode === "create" && setup.phase === "backup_pending" && setup.backupPositions && source,
    "SETUP_CONFLICT", "The backup confirmation is not ready.");
  const key = await input.protection.get(source.keyRef);
  if (!key || key.byteLength !== 32) { key?.fill(0); throw new WalletError("GENERAL_STORE_UNAVAILABLE", "The protected source key is unavailable."); }
  const current = () => {
    input.admission(); requireWallet(!signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
  };
  try {
    current();
    const value = await input.crypto({ operation: "verify", ownerId: snapshot.ownerId, keySourceId: source.id,
      key, address: source.address, envelope: source.protectedMaterial, positions: setup.backupPositions, words: input.words }, signal);
    current();
    const verified = !!value && typeof value === "object" && "verified" in value && value.verified === true;
    if (!verified) return false;
    await state.mutate((next) => {
      current();
      next.setups = [...transitionGeneralSetup(next.setups, { type: "confirm", id: setupId }, input.secretAdmission?.() ?? "verified")];
      const item = next.sources.find((entry) => entry.setupId === setupId);
      requireWallet(item, "GENERAL_STORE_UNAVAILABLE", "The protected source is unavailable.");
      item.status = "ready"; item.backupVerified = true;
    });
    input.admission();
    // Cancellation cannot undo an account after the protected write committed.
    return true;
  } finally { key.fill(0); }
}

export function createGeneralBackupChallenge(): number[] {
  const values = Array.from({ length: 12 }, (_, index) => index);
  return Array.from({ length: 3 }, () => values.splice(randomInt(values.length), 1)[0]!);
}
