import { z } from "zod";
import { randomUUID } from "node:crypto";
import { digest } from "./canonical.js";
import { validateGeneralBackupPreview } from "./generalBackupPreview.js";
import { validateGeneralState } from "../app/generalState.js";
import { assertGeneralRestoreArchiveInput, validateGeneralRestorePlan, type GeneralRestorePlan } from "./generalRestorePlan.js";
import { validateGeneralInitializationRecord, assertGeneralInitializationState, type GeneralInitializationRecord } from "./generalInitializationRecord.js";
import { generalInitializationPlanBody, generalInitializationPlanDigest } from "./generalInitializationBinding.js";
import { checkGeneralRecovery, checkGeneralRecoverySize, generalRecoveryId, generalRecoveryUid, invalidGeneralRecovery } from "./generalRecoveryRecord.js";

const CODE = "GENERAL_RESTORE_PLAN_INVALID";
const identity = z.strictObject({ uid: generalRecoveryUid, installationId: generalRecoveryId });
export type GeneralFirstRestoreIdentity = z.infer<typeof identity>;
export type GeneralFirstRestorePrepared = { plan: GeneralRestorePlan; initialization: GeneralInitializationRecord;
  reservation: ReturnType<typeof generalInitializationPlanBody> };
export function validateGeneralFirstRestoreIdentity(value: unknown): GeneralFirstRestoreIdentity {
  const result = identity.safeParse(value); if (!result.success) return invalidGeneralRecovery(CODE); return result.data;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}

/** Private pure candidate construction only. A supplied preview or identity
 * does not prove AEAD authentication, fresh Root origin, scope or admission. */
export function prepareGeneralFirstRestorePlan(value: unknown, identityValue: GeneralFirstRestoreIdentity): GeneralFirstRestorePrepared {
  const preview = validateGeneralBackupPreview(value), target = validateGeneralFirstRestoreIdentity(identityValue);
  const archive = preview.archive, source = archive.sourceState;
  checkGeneralRecovery(source.installationId !== target.installationId, CODE);
  const enrollmentId = randomUUID(), initializationId = randomUUID(), recoveryId = randomUUID(), profileId = randomUUID();
  const state = validateGeneralState({ ...source, installationId: target.installationId });
  const body = { format: "koincode-general-restore-plan" as const, version: 1 as const, recoveryId, backupId: preview.backupId,
    authenticatedPayloadDigest: preview.payloadDigest, mode: "new_installation" as const, enrollmentId,
    source: { ownerId: source.ownerId, installationId: source.installationId, revision: source.revision,
      stateCommitment: digest(source), signingCheckpointDigest: digest(archive.history.signing) },
    target: { ownerId: source.ownerId, installationId: target.installationId, profileId, previousBindingDigest: null, state,
      stateCommitment: digest(state), archiveDigest: digest(archive), signingContinuity: "unknown" as const, latestProtectedHeadDigest: null },
    keyRefs: [...archive.keyRefs] };
  const plan = validateGeneralRestorePlan({ ...body, planDigest: digest(body), phase: "prepared" });
  assertGeneralRestoreArchiveInput(plan, archive);
  const initial = { format: "koincode-general-initialization" as const, version: 1 as const, uid: target.uid,
    ownerId: source.ownerId, installationId: target.installationId, enrollmentId, initializationId,
    kind: "restore" as const, targetStateCommitment: plan.target.stateCommitment, initialSigningDomainId: archive.history.signing.domainId,
    phase: "prepared" as const, planDigest: "0".repeat(64) };
  const initialization = validateGeneralInitializationRecord({ ...initial, planDigest: generalInitializationPlanDigest(initial, plan.planDigest) });
  assertGeneralInitializationState(initialization, state);
  const reservation = generalInitializationPlanBody(initialization, plan.planDigest);
  checkGeneralRecovery(digest(reservation) === initialization.planDigest, CODE); checkGeneralRecoverySize(reservation, 16 * 1024, CODE);
  return freeze({ plan, initialization, reservation });
}
