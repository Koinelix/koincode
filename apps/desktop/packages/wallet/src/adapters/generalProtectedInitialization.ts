import { randomUUID } from "node:crypto";
import { validateGeneralState } from "../app/generalState.js";
import { GENERAL_SIGNING_POLICY_DIGEST, GENERAL_SIGNING_POLICY_VERSION } from "../domain/generalSigningPolicy.js";
import { requireWallet } from "../domain/errors.js";
import { digest } from "./canonical.js";
import { validateGeneralInitializationRecord } from "./generalInitializationRecord.js";

/** Candidate metadata only. Native Root/head admission independently validates
 * the exact plan and can refuse it. Never call for an existing assignment. */
export function generalProtectedInitialCandidate(identity: { uid: number; installationId: string }) {
  requireWallet(Number.isSafeInteger(identity.uid) && identity.uid > 0 && identity.uid < 0xffffffff,
    "GENERAL_INITIALIZATION_RECORD_INVALID", "The actual installation user is invalid.");
  const state = validateGeneralState({ format: "koincode-general-wallet-state", version: 1, ownerId: randomUUID(), installationId: identity.installationId,
    revision: 0, signingPolicyVersion: GENERAL_SIGNING_POLICY_VERSION, signingPolicyDigest: GENERAL_SIGNING_POLICY_DIGEST, setups: [], sources: [] });
  const plan = { format: "koincode-general-initialization-plan", version: 1, uid: identity.uid, installationId: identity.installationId,
    ownerId: state.ownerId, enrollmentId: randomUUID(), initializationId: randomUUID(), initialSigningDomainId: randomUUID(), kind: "new" as const,
    targetStateCommitment: digest(state), recoveryPlanDigest: null };
  const { recoveryPlanDigest: _recovery, ...common } = plan;
  const record = validateGeneralInitializationRecord({ ...common, format: "koincode-general-initialization", planDigest: digest(plan), phase: "prepared" });
  return { state, record };
}
