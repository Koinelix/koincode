import { validateGeneralInitializationRecord, validateGeneralAssignment } from "./generalInitializationRecord.js";
import { validateGeneralRestorePlan, assertGeneralRestorePlanInput, type GeneralRestorePlan } from "./generalRestorePlan.js";
import type { GeneralBackupPayload } from "./generalBackupPayload.js";
import { digest } from "./canonical.js";
import { checkGeneralRecovery, generalRecoveryHash, invalidGeneralRecovery } from "./generalRecoveryRecord.js";

const CODE = "GENERAL_INITIALIZATION_RECORD_INVALID";
type Recovery = { plan: GeneralRestorePlan; payload: GeneralBackupPayload } | null;

/** A format commitment only. The caller still needs native enrollment and the original frozen state. */
export function generalInitializationPlanBody(value: unknown, recoveryPlanDigest: string | null) {
  try {
    const record = validateGeneralInitializationRecord(value);
    generalRecoveryHash.nullable().parse(recoveryPlanDigest);
    checkGeneralRecovery((record.kind === "new") === (recoveryPlanDigest === null), CODE);
    return { format: "koincode-general-initialization-plan" as const, version: 1 as const,
      initializationId: record.initializationId, enrollmentId: record.enrollmentId, uid: record.uid,
      installationId: record.installationId, ownerId: record.ownerId, kind: record.kind,
      targetStateCommitment: record.targetStateCommitment, initialSigningDomainId: record.initialSigningDomainId,
      recoveryPlanDigest };
  } catch { return invalidGeneralRecovery(CODE); }
}

export function generalInitializationPlanDigest(value: unknown, recoveryPlanDigest: string | null): string {
  try { return digest(generalInitializationPlanBody(value, recoveryPlanDigest)); }
  catch { return invalidGeneralRecovery(CODE); }
}

/** Does not verify root ownership, payload authentication, material decryption or native provenance. */
export function assertGeneralInitializationBinding(value: unknown, assignmentValue: unknown, recovery: Recovery): void {
  try {
    const record = validateGeneralInitializationRecord(value), assignment = validateGeneralAssignment(assignmentValue);
    checkGeneralRecovery(record.uid === assignment.uid && record.ownerId === assignment.ownerId &&
      record.installationId === assignment.installationId && record.enrollmentId === assignment.enrollmentId &&
      record.initializationId === assignment.initializationId && record.planDigest === assignment.initializationDigest, CODE);
    let recoveryPlanDigest: string | null = null;
    if (record.kind === "restore") {
      checkGeneralRecovery(recovery !== null, CODE);
      const plan = validateGeneralRestorePlan(recovery.plan);
      assertGeneralRestorePlanInput(plan, recovery.payload);
      checkGeneralRecovery(plan.mode === "new_installation" && plan.enrollmentId === record.enrollmentId &&
        plan.target.ownerId === record.ownerId && plan.target.installationId === record.installationId &&
        plan.target.stateCommitment === record.targetStateCommitment &&
        recovery.payload.history.signing.domainId === record.initialSigningDomainId, CODE);
      recoveryPlanDigest = plan.planDigest;
    } else checkGeneralRecovery(recovery === null, CODE);
    checkGeneralRecovery(record.planDigest === generalInitializationPlanDigest(record, recoveryPlanDigest), CODE);
  } catch { invalidGeneralRecovery(CODE); }
}
