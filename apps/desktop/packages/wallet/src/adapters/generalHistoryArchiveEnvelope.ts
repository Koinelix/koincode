import { z } from "zod";
import { createHash } from "node:crypto";
import { WalletError } from "../domain/errors.js";
import { canonical } from "./canonical.js";
import { GENERAL_BACKUP_MAX_BYTES, GENERAL_BACKUP_MAX_PAYLOAD, type GeneralBackupPayload } from "./generalBackupPayload.js";
import { validateGeneralRestorePlan, type GeneralRestorePlan } from "./generalRestorePlan.js";
import { generalRecoveryHash as hash, generalRecoveryId as id, parseGeneralRecoveryRecord } from "./generalRecoveryRecord.js";

export const GENERAL_HISTORY_ARCHIVE_TYPE = "koincode-general-history-archive+jwe";
const headerSchema = z.strictObject({ alg: z.literal("dir"), enc: z.literal("A256GCM"), typ: z.literal(GENERAL_HISTORY_ARCHIVE_TYPE),
  version: z.literal(1), ownerId: id, installationId: id, enrollmentId: id, recoveryId: id, profileId: id, artifactId: id,
  planDigest: hash, archiveDigest: hash });
export type GeneralHistoryArchiveHeader = z.infer<typeof headerSchema>;
export type GeneralHistoryArchiveEncrypted = { archive: string; archiveDigest: string; archiveCiphertextDigest: string; artifactId: string };
export type GeneralHistoryArchiveJob = { operation: "encrypt_archive"; payload: GeneralBackupPayload; plan: GeneralRestorePlan; artifactId: string }
  | { operation: "decrypt_archive"; archive: string; key: Uint8Array; plan: GeneralRestorePlan; artifactId: string };

export function invalidGeneralHistoryArchive(): never {
  throw new WalletError("GENERAL_HISTORY_ARCHIVE_INVALID", "The protected history archive could not be verified.");
}
export function checkGeneralHistoryArchive(value: unknown): asserts value { if (!value) invalidGeneralHistoryArchive(); }

function segment(value: string, length?: number): Buffer {
  checkGeneralHistoryArchive(/^[A-Za-z0-9_-]+$/.test(value));
  const bytes = Buffer.from(value, "base64url");
  checkGeneralHistoryArchive(bytes.toString("base64url") === value && (length === undefined || bytes.byteLength === length));
  return bytes;
}

/** Public metadata inspection only; no plaintext is parsed until AEAD authentication succeeds. */
export function inspectGeneralHistoryArchive(archive: string): GeneralHistoryArchiveHeader {
  try {
    checkGeneralHistoryArchive(typeof archive === "string" && archive.length > 0 && Buffer.byteLength(archive) <= GENERAL_BACKUP_MAX_BYTES);
    const parts = archive.split(".");
    checkGeneralHistoryArchive(parts.length === 5 && parts[0]!.length <= 1400 && parts[1] === "");
    const header = headerSchema.parse(parseGeneralRecoveryRecord(segment(parts[0]!), 1400, "GENERAL_HISTORY_ARCHIVE_INVALID"));
    segment(parts[2]!, 12); segment(parts[4]!, 16);
    const ciphertext = segment(parts[3]!);
    checkGeneralHistoryArchive(ciphertext.byteLength <= GENERAL_BACKUP_MAX_PAYLOAD);
    ciphertext.fill(0); return header;
  } catch { return invalidGeneralHistoryArchive(); }
}

/** Scope equality is not native authorization or proof that the supplied artifact was published. */
export function generalHistoryArchiveHeader(planValue: unknown, artifactId: string): GeneralHistoryArchiveHeader {
  try {
    const plan = validateGeneralRestorePlan(planValue); id.parse(artifactId);
    return headerSchema.parse({ alg: "dir", enc: "A256GCM", typ: GENERAL_HISTORY_ARCHIVE_TYPE, version: 1,
      ownerId: plan.target.ownerId, installationId: plan.target.installationId, enrollmentId: plan.enrollmentId,
      recoveryId: plan.recoveryId, profileId: plan.target.profileId, artifactId, planDigest: plan.planDigest,
      archiveDigest: plan.target.archiveDigest });
  } catch { return invalidGeneralHistoryArchive(); }
}

/** Ciphertext validation only; authenticity and durable publication still require their original worker/native owners. */
export function validateGeneralHistoryArchiveEncrypted(value: unknown, plan: GeneralRestorePlan, artifactId: string): GeneralHistoryArchiveEncrypted {
  try {
    checkGeneralHistoryArchive(value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).sort().join() === "archive,archiveCiphertextDigest,archiveDigest,artifactId");
    const row = value as GeneralHistoryArchiveEncrypted, expected = generalHistoryArchiveHeader(plan, artifactId);
    checkGeneralHistoryArchive(row.artifactId === artifactId && row.archiveDigest === expected.archiveDigest &&
      canonical(inspectGeneralHistoryArchive(row.archive)) === canonical(expected) &&
      row.archiveCiphertextDigest === createHash("sha256").update(row.archive, "ascii").digest("hex"));
    return { archive: row.archive, archiveDigest: row.archiveDigest, archiveCiphertextDigest: row.archiveCiphertextDigest, artifactId };
  } catch { return invalidGeneralHistoryArchive(); }
}

/** Bound parent-side admission before cloning a job; no source-material decryption or key derivation occurs here. */
export function assertGeneralHistoryArchiveJob(job: GeneralHistoryArchiveJob): void {
  try {
    checkGeneralHistoryArchive(job && typeof job === "object" && !Array.isArray(job));
    generalHistoryArchiveHeader(job.plan, job.artifactId);
    if (job.operation === "encrypt_archive") {
      checkGeneralHistoryArchive(Object.keys(job).sort().join() === "artifactId,operation,payload,plan" && job.payload &&
        typeof job.payload === "object" && Buffer.byteLength(canonical(job.payload)) <= GENERAL_BACKUP_MAX_PAYLOAD);
    } else {
      checkGeneralHistoryArchive(job.operation === "decrypt_archive" && Object.keys(job).sort().join() === "archive,artifactId,key,operation,plan" &&
        job.key instanceof Uint8Array && job.key.byteLength === 32);
      checkGeneralHistoryArchive(canonical(inspectGeneralHistoryArchive(job.archive)) === canonical(generalHistoryArchiveHeader(job.plan, job.artifactId)));
    }
  } catch { invalidGeneralHistoryArchive(); }
}
