import type { ProtectedStore } from "./ports.js";
import type { InitializationTicket, StateCommitment, StateRepository } from "./state.js";
import {
  protectedJson,
  rootMatches,
  sameCommitment,
  type RootRegistration,
} from "./commitments.js";
import { requireWallet } from "../domain/errors.js";
export async function initializeRepository(
  repository: StateRepository,
  protection: ProtectedStore,
  ticket: InitializationTicket,
): Promise<void> {
  const { attempt, attemptId, mode } = repository.beginInitialization(ticket);
  const previous = repository.read();
  const next = structuredClone(previous);
  next.revision = 1;
  const commitment = repository.commitment(next);
  repository.validate(previous, next);
  const rootAccount = "root:" + commitment.storageBinding;
  const anchorAccount = "anchor:" + previous.installationId;
  const root = await protectedJson<RootRegistration>(protection, rootAccount);
  const anchor = await protectedJson<StateCommitment>(protection, anchorAccount);
  requireWallet(
    previous.initializationAttempt === attemptId,
    "INITIALIZATION_CAPABILITY_INVALID",
    "The setup attempt changed before registration.",
  );
  if (mode === "fresh")
    requireWallet(
      root === null && anchor === null,
      "WALLET_RECOVERY_REQUIRED",
      "This root already has protected history.",
    );
  else {
    requireWallet(
      root === null
        ? anchor === null
        : rootMatches(root, previous, commitment.storageBinding) &&
            sameCommitment(root.initialCommitment, commitment) &&
            ((root.phase === "REGISTERED" &&
              (anchor === null || sameCommitment(anchor, commitment))) ||
              (root.phase === "READY" && sameCommitment(anchor, commitment))),
      "WALLET_RECOVERY_REQUIRED",
      "Protected setup evidence does not match this pending attempt.",
    );
  }
  const registration: RootRegistration = {
    version: 1,
    installationId: previous.installationId,
    ownerId: previous.ownerId,
    storageBinding: commitment.storageBinding,
    attemptId,
    phase: "REGISTERED",
    initialCommitment: commitment,
  };
  async function put(account: string, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value));
    try {
      await protection.put(account, bytes);
    } finally {
      bytes.fill(0);
    }
  }
  if (root === null) await put(rootAccount, registration);
  if (anchor === null) await put(anchorAccount, commitment);
  if (root?.phase !== "READY") await put(rootAccount, { ...registration, phase: "READY" });
  repository.finishInitialization(previous, next, commitment, attempt);
}
