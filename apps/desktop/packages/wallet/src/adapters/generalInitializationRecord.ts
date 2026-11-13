import { z } from "zod";
import { validateGeneralState } from "../app/generalState.js";
import { GENERAL_SIGNING_POLICY_DIGEST, GENERAL_SIGNING_POLICY_VERSION } from "../domain/generalSigningPolicy.js";
import { canonical, digest } from "./canonical.js";
import { assertGeneralRecoveryPhase, checkGeneralRecovery, checkGeneralRecoverySize, generalRecoveryHash as hash,
  generalRecoveryId as id, generalRecoveryUid as uid, invalidGeneralRecovery, parseGeneralRecoveryRecord } from "./generalRecoveryRecord.js";

const CODE = "GENERAL_INITIALIZATION_RECORD_INVALID", MAXIMUM = 16 * 1024;
const phases = ["prepared", "state_published", "journal_published", "ready"] as const;
const recordSchema = z.strictObject({ format: z.literal("koincode-general-initialization"), version: z.literal(1),
  initializationId: id, enrollmentId: id, uid, installationId: id, ownerId: id, kind: z.enum(["new", "restore"]),
  targetStateCommitment: hash, initialSigningDomainId: id, planDigest: hash, phase: z.enum(phases) });
const assignmentSchema = z.strictObject({ format: z.literal("koincode-general-wallet-assignment"), version: z.literal(1),
  uid, enrollmentId: id, installationId: id, ownerId: id, initializationId: id, initializationDigest: hash,
  signingPolicyVersion: z.literal(GENERAL_SIGNING_POLICY_VERSION), signingPolicyDigest: z.literal(GENERAL_SIGNING_POLICY_DIGEST) });
export type GeneralInitializationRecord = z.infer<typeof recordSchema>;
export type GeneralAssignment = z.infer<typeof assignmentSchema>;

/** Internal format validation only. This does not verify binary-plist encoding, root ownership, the lock or caller identity. */
export function validateGeneralAssignment(value: unknown): GeneralAssignment {
  try { checkGeneralRecoverySize(value, MAXIMUM, CODE); return assignmentSchema.parse(value); }
  catch { return invalidGeneralRecovery(CODE); }
}

/** The native plan commitment remains opaque here. No JS digest or parsed phase can substitute for native enrollment. */
export function validateGeneralInitializationRecord(value: unknown): GeneralInitializationRecord {
  try { checkGeneralRecoverySize(value, MAXIMUM, CODE); return recordSchema.parse(value); }
  catch { return invalidGeneralRecovery(CODE); }
}

export function parseGeneralInitializationRecord(bytes: Uint8Array): GeneralInitializationRecord {
  return validateGeneralInitializationRecord(parseGeneralRecoveryRecord(bytes, MAXIMUM, CODE));
}

/** Checks an already supplied snapshot, without issuing the distinct native restore/initialization credential. */
export function assertGeneralInitializationState(value: unknown, input: unknown): void {
  try {
    const record = validateGeneralInitializationRecord(value), state = validateGeneralState(input);
    checkGeneralRecoverySize(state, 512 * 1024, CODE);
    checkGeneralRecovery(record.ownerId === state.ownerId && record.installationId === state.installationId &&
      record.targetStateCommitment === digest(state) && (record.kind === "restore" ||
        (state.revision === 0 && state.sources.length === 0 && state.setups.length === 0)), CODE);
  } catch { invalidGeneralRecovery(CODE); }
}

export function assertGeneralInitializationAdvance(previous: unknown, next: unknown): void {
  const before = validateGeneralInitializationRecord(previous), after = validateGeneralInitializationRecord(next);
  const { phase: oldPhase, ...oldBody } = before, { phase: newPhase, ...newBody } = after;
  checkGeneralRecovery(canonical(oldBody) === canonical(newBody), CODE);
  assertGeneralRecoveryPhase(oldPhase, newPhase, phases, CODE);
}
