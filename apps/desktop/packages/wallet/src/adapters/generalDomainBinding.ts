import { z } from "zod";
import { digest, canonical } from "./canonical.js";
import { validateGeneralAssignment, validateGeneralInitializationRecord } from "./generalInitializationRecord.js";
import { assertGeneralInitializationBinding } from "./generalInitializationBinding.js";
import { validateGeneralRestorePlan } from "./generalRestorePlan.js";
import { parseGeneralSigningCheckpoint } from "./generalSigningJournal.js";
import { checkGeneralRecovery, checkGeneralRecoverySize, generalRecoveryHash as hash, generalRecoveryId as id,
  generalRecoveryInteger as integer, generalRecoveryUid as uid, invalidGeneralRecovery, parseGeneralRecoveryRecord } from "./generalRecoveryRecord.js";

const CODE = "GENERAL_DOMAIN_BINDING_INVALID", MAXIMUM = 16 * 1024;
const schema = z.strictObject({ format: z.literal("koincode-general-domain-binding"), version: z.literal(1),
  uid, ownerId: id, installationId: id, enrollmentId: id, revision: integer.min(1), profileId: id,
  origin: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("new"), initializationId: id, initializationDigest: hash }),
    z.strictObject({ kind: z.literal("restore"), recoveryId: id, planDigest: hash, archiveDigest: hash,
      artifactId: id, archiveCiphertextDigest: hash }),
  ]),
  signing: z.discriminatedUnion("mode", [z.strictObject({ mode: z.literal("live"), domainId: id }),
    z.strictObject({ mode: z.literal("archive_only"), domainId: z.null() })]),
  previousBindingDigest: hash.nullable(), bindingDigest: hash });
export type GeneralDomainBinding = z.infer<typeof schema>;
type Scope = Pick<GeneralDomainBinding, "uid" | "ownerId" | "installationId" | "enrollmentId">;
const sameScope = (a: Scope, b: Scope): boolean => a.uid === b.uid && a.ownerId === b.ownerId &&
  a.installationId === b.installationId && a.enrollmentId === b.enrollmentId;

/** Format validation only. A parsed binding never selects an active profile or grants signing authority. */
export function validateGeneralDomainBinding(value: unknown): GeneralDomainBinding {
  try {
    checkGeneralRecoverySize(value, MAXIMUM, CODE);
    const row = schema.parse(value), { bindingDigest, ...body } = row;
    checkGeneralRecovery(bindingDigest === digest(body) && (row.revision === 1) === (row.previousBindingDigest === null), CODE);
    if (row.origin.kind === "new") {
      checkGeneralRecovery(row.revision === 1 && row.profileId === row.origin.initializationId && row.signing.mode === "live", CODE);
    } else if (row.revision === 1) checkGeneralRecovery(row.signing.mode === "archive_only", CODE);
    return row;
  } catch { return invalidGeneralRecovery(CODE); }
}

export function parseGeneralDomainBinding(bytes: Uint8Array): GeneralDomainBinding {
  return validateGeneralDomainBinding(parseGeneralRecoveryRecord(bytes, MAXIMUM, CODE));
}

/** Associates supplied records only; real state/journal creation, native first-use admission and ready remain mandatory. */
export function assertGeneralNewDomainBinding(value: unknown, assignmentValue: unknown, initializationValue: unknown): void {
  try {
    const row = validateGeneralDomainBinding(value), assignment = validateGeneralAssignment(assignmentValue);
    const initialization = validateGeneralInitializationRecord(initializationValue);
    assertGeneralInitializationBinding(initialization, assignment, null);
    checkGeneralRecovery(sameScope(row, assignment) && initialization.kind === "new" && row.origin.kind === "new" &&
      row.origin.initializationId === initialization.initializationId && row.origin.initializationDigest === initialization.planDigest &&
      row.signing.mode === "live" && row.signing.domainId === initialization.initialSigningDomainId, CODE);
  } catch { invalidGeneralRecovery(CODE); }
}

/** Checks links, not the archive file, local journal freshness, native CAS or restore credential. */
export function assertGeneralRestoreDomainBinding(value: unknown, assignmentValue: unknown, planValue: unknown, previousValue: unknown | null): void {
  try {
    const row = validateGeneralDomainBinding(value), assignment = validateGeneralAssignment(assignmentValue), plan = validateGeneralRestorePlan(planValue);
    checkGeneralRecovery(sameScope(row, assignment) && row.ownerId === plan.target.ownerId &&
      row.installationId === plan.target.installationId && row.enrollmentId === plan.enrollmentId &&
      row.profileId === plan.target.profileId && row.previousBindingDigest === plan.target.previousBindingDigest &&
      row.origin.kind === "restore" && row.origin.recoveryId === plan.recoveryId && row.origin.planDigest === plan.planDigest &&
      row.origin.archiveDigest === plan.target.archiveDigest, CODE);
    if (previousValue === null) {
      checkGeneralRecovery(plan.mode === "new_installation" && row.revision === 1 && row.signing.mode === "archive_only", CODE);
    } else {
      const previous = validateGeneralDomainBinding(previousValue);
      checkGeneralRecovery(plan.mode === "same_installation" && sameScope(previous, assignment) &&
        previous.revision < Number.MAX_SAFE_INTEGER && row.revision === previous.revision + 1 &&
        row.previousBindingDigest === previous.bindingDigest && row.profileId !== previous.profileId, CODE);
      if (plan.target.signingContinuity === "complete") {
        checkGeneralRecovery(previous.signing.mode === "live" && row.signing.mode === "live" &&
          row.signing.domainId === previous.signing.domainId, CODE);
      } else checkGeneralRecovery(row.signing.mode === "archive_only", CODE);
    }
  } catch { invalidGeneralRecovery(CODE); }
}

/** Pure aggregation of an already captured checkpoint; equal hashes alone do not prove it is the latest native state. */
export function generalLatestProtectedHeadDigest(value: unknown): string {
  try {
    const inspected = parseGeneralSigningCheckpoint(Buffer.from(canonical(value)));
    checkGeneralRecovery(inspected.policy === "v3", CODE);
    const { format: _format, version: _version, streams, ...identity } = inspected.checkpoint;
    return digest({ ...identity, streams: streams.map(({ events: _events, ...metadata }) => metadata)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) });
  } catch { return invalidGeneralRecovery(CODE); }
}
