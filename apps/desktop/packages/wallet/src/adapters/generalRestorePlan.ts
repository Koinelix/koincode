import { z } from "zod";
import { assertGeneralStateAdvance, assertGeneralStateForward, validateGeneralState, type GeneralWalletState } from "../app/generalState.js";
import { canonical, digest } from "./canonical.js";
import { validateGeneralBackupPayload, generalBackupArchiveSnapshot, validateGeneralBackupArchive,
  type GeneralBackupPayload, type GeneralBackupArchive } from "./generalBackupPayload.js";
import { assertGeneralRecoveryPhase, checkGeneralRecovery, checkGeneralRecoverySize, generalRecoveryHash as hash,
  generalRecoveryId as id, generalRecoveryInteger as integer, invalidGeneralRecovery, parseGeneralRecoveryRecord } from "./generalRecoveryRecord.js";

const CODE = "GENERAL_RESTORE_PLAN_INVALID", MAXIMUM = 1024 * 1024;
const phases = ["prepared", "keys_staged", "projection_staged", "binding_published", "reopened"] as const;
const keyRef = z.string().regex(/^source-key:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const schema = z.strictObject({ format: z.literal("koincode-general-restore-plan"), version: z.literal(1),
  recoveryId: id, backupId: id, authenticatedPayloadDigest: hash, mode: z.enum(["same_installation", "new_installation"]), enrollmentId: id,
  source: z.strictObject({ ownerId: id, installationId: id, revision: integer, stateCommitment: hash, signingCheckpointDigest: hash }),
  target: z.strictObject({ ownerId: id, installationId: id, profileId: id, previousBindingDigest: hash.nullable(), state: z.unknown(),
    stateCommitment: hash, archiveDigest: hash, signingContinuity: z.enum(["complete", "unknown"]), latestProtectedHeadDigest: hash.nullable() }),
  keyRefs: z.array(keyRef).min(1).max(1256), planDigest: hash, phase: z.enum(phases) });
export type GeneralRestorePlan = Omit<z.infer<typeof schema>, "target"> & {
  target: Omit<z.infer<typeof schema>["target"], "state"> & { state: GeneralWalletState };
};

function body(value: GeneralRestorePlan): Omit<GeneralRestorePlan, "planDigest" | "phase"> {
  const { planDigest: _digest, phase: _phase, ...result } = value;
  return result;
}

/** No keys are part of this archive commitment. The archived values retain their original installation identity. */
export function generalRestoreArchiveDigest(payload: GeneralBackupPayload): string {
  return digest(generalBackupArchiveSnapshot(payload));
}

/** Structural only: even complete/reopened records cannot grant initialization, publication or signing authority. */
export function validateGeneralRestorePlan(value: unknown): GeneralRestorePlan {
  try {
    checkGeneralRecoverySize(value, MAXIMUM, CODE);
    const row = schema.parse(value), state = validateGeneralState(row.target.state);
    checkGeneralRecoverySize(state, 512 * 1024, CODE);
    const result: GeneralRestorePlan = { ...row, target: { ...row.target, state } };
    checkGeneralRecovery(row.source.ownerId === row.target.ownerId && state.ownerId === row.target.ownerId &&
      state.installationId === row.target.installationId && row.target.stateCommitment === digest(state) &&
      row.planDigest === digest(body(result)), CODE);
    checkGeneralRecovery(row.keyRefs.every((ref, index) => index === 0 || row.keyRefs[index - 1]! < ref), CODE);
    checkGeneralRecovery(row.target.signingContinuity === "complete" ? row.target.latestProtectedHeadDigest !== null :
      row.target.latestProtectedHeadDigest === null, CODE);
    if (row.mode === "new_installation") {
      checkGeneralRecovery(row.source.installationId !== row.target.installationId && row.target.previousBindingDigest === null &&
        row.target.signingContinuity === "unknown" && state.revision === row.source.revision, CODE);
    } else {
      checkGeneralRecovery(row.source.installationId === row.target.installationId && row.target.previousBindingDigest !== null &&
        state.revision >= row.source.revision && (state.revision !== row.source.revision || row.source.stateCommitment === row.target.stateCommitment), CODE);
    }
    return result;
  } catch { return invalidGeneralRecovery(CODE); }
}

export function parseGeneralRestorePlan(bytes: Uint8Array): GeneralRestorePlan {
  return validateGeneralRestorePlan(parseGeneralRecoveryRecord(bytes, MAXIMUM, CODE));
}

/** Call only inside the protected restore owner after authenticating/decrypting/verifying the payload's materials. */
export function assertGeneralRestorePlanInput(value: unknown, input: GeneralBackupPayload): void {
  try {
    const plan = validateGeneralRestorePlan(value), payload = validateGeneralBackupPayload(input);
    checkGeneralRecovery(plan.backupId === payload.backupId && plan.authenticatedPayloadDigest === digest(payload), CODE);
    assertGeneralRestoreArchiveInput(plan, generalBackupArchiveSnapshot(payload));
  } catch { invalidGeneralRecovery(CODE); }
}

/** Authenticated archive association only; it cannot prove possession of omitted wrapping keys or current journal freshness. */
export function assertGeneralRestoreArchiveInput(value: unknown, input: GeneralBackupArchive): void {
  try {
    const plan = validateGeneralRestorePlan(value), archive = validateGeneralBackupArchive(input), state = archive.sourceState;
    checkGeneralRecovery(canonical(plan.source) === canonical({ ownerId: state.ownerId, installationId: state.installationId,
      revision: state.revision, stateCommitment: digest(state), signingCheckpointDigest: digest(archive.history.signing) }) &&
      plan.target.archiveDigest === digest(archive) && canonical(plan.keyRefs) === canonical(archive.keyRefs), CODE);
    if (plan.mode === "new_installation") {
      checkGeneralRecovery(canonical(plan.target.state) === canonical({ ...state, installationId: plan.target.installationId }), CODE);
    } else if (plan.target.state.revision === state.revision) {
      checkGeneralRecovery(canonical(plan.target.state) === canonical(state), CODE);
    } else assertGeneralStateForward(state, plan.target.state);
  } catch { invalidGeneralRecovery(CODE); }
}

/** Preserves the separately verified local source snapshot; it does not verify journal/head continuity or publish a binding. */
export function assertGeneralRestoreLocalState(value: unknown, current: GeneralWalletState): void {
  try {
    const plan = validateGeneralRestorePlan(value), previous = validateGeneralState(current);
    checkGeneralRecovery(plan.mode === "same_installation", CODE);
    if (canonical(plan.target.state) !== canonical(previous)) assertGeneralStateAdvance(previous, plan.target.state);
  } catch { invalidGeneralRecovery(CODE); }
}

export function assertGeneralRestorePlanAdvance(previous: unknown, next: unknown): void {
  const before = validateGeneralRestorePlan(previous), after = validateGeneralRestorePlan(next);
  checkGeneralRecovery(canonical(body(before)) === canonical(body(after)) && before.planDigest === after.planDigest, CODE);
  assertGeneralRecoveryPhase(before.phase, after.phase, phases, CODE);
}
