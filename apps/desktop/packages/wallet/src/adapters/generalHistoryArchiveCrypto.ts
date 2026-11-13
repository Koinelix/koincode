import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { CompactEncrypt, compactDecrypt } from "jose";
import { canonical, digest } from "./canonical.js";
import { generalBackupArchiveSnapshot, validateGeneralBackupPayload, validateGeneralBackupArchive, GENERAL_BACKUP_MAX_BYTES,
  GENERAL_BACKUP_MAX_PAYLOAD, type GeneralBackupArchive } from "./generalBackupPayload.js";
import { assertGeneralRestorePlanInput, assertGeneralRestoreArchiveInput, validateGeneralRestorePlan } from "./generalRestorePlan.js";
import { verifyGeneralBackupMaterials } from "./generalBackupMaterials.js";
import { parseGeneralRecoveryRecord } from "./generalRecoveryRecord.js";
import { assertGeneralHistoryArchiveJob, checkGeneralHistoryArchive, generalHistoryArchiveHeader, inspectGeneralHistoryArchive,
  invalidGeneralHistoryArchive, type GeneralHistoryArchiveJob, type GeneralHistoryArchiveEncrypted } from "./generalHistoryArchiveEnvelope.js";

export type { GeneralHistoryArchiveEncrypted } from "./generalHistoryArchiveEnvelope.js";
/** Privacy-bearing history stays inside the protected restore owner, never an ordinary renderer, SDK or model. */
export type GeneralHistoryArchiveDecrypted = { archive: GeneralBackupArchive; archiveDigest: string; archiveCiphertextDigest: string; artifactId: string };

/** Internal subkey primitive. Native scope, the exact staged source key and the current binding remain caller requirements. */
export function deriveGeneralHistoryArchiveKey(key: Uint8Array, planValue: unknown, artifactId: string): Uint8Array {
  let original: Buffer | undefined;
  try {
    checkGeneralHistoryArchive(key instanceof Uint8Array && key.byteLength === 32);
    const plan = validateGeneralRestorePlan(planValue), header = generalHistoryArchiveHeader(plan, artifactId);
    const { alg: _alg, enc: _enc, typ: _typ, ...scope } = header;
    const info = Buffer.from(canonical({ ...scope, format: "koincode-general-history-archive-key", keyRef: plan.keyRefs[0] }));
    const salt = createHash("sha256").update("koincode-general-history-archive-key/v1", "utf8").digest();
    original = Buffer.from(key);
    return new Uint8Array(hkdfSync("sha256", original, salt, info, 32));
  } catch { return invalidGeneralHistoryArchive(); }
  finally { original?.fill(0); }
}

/** Runs only as a bounded new-domain backup-class worker task. No file, native or signing authority is conferred. */
export async function executeGeneralHistoryArchiveJob(job: GeneralHistoryArchiveJob): Promise<GeneralHistoryArchiveEncrypted | GeneralHistoryArchiveDecrypted> {
  let key: Uint8Array | undefined, original: Buffer | undefined, plaintext: Uint8Array | undefined;
  try {
    assertGeneralHistoryArchiveJob(job);
    const plan = validateGeneralRestorePlan(job.plan), header = generalHistoryArchiveHeader(plan, job.artifactId);
    if (job.operation === "encrypt_archive") {
      const payload = validateGeneralBackupPayload(job.payload);
      assertGeneralRestorePlanInput(plan, payload); await verifyGeneralBackupMaterials(payload);
      const selected = payload.wrappingKeys.find((entry) => entry.keyRef === plan.keyRefs[0]); checkGeneralHistoryArchive(selected);
      original = Buffer.from(selected.key, "base64url"); key = deriveGeneralHistoryArchiveKey(original, plan, job.artifactId);
      const archiveBody = validateGeneralBackupArchive(generalBackupArchiveSnapshot(payload));
      plaintext = Buffer.from(canonical(archiveBody));
      checkGeneralHistoryArchive(plaintext.byteLength <= GENERAL_BACKUP_MAX_PAYLOAD && digest(archiveBody) === header.archiveDigest);
      // Insertion order is fixed by the approved canonical encoding before jose serializes the protected header.
      const archive = await new CompactEncrypt(plaintext).setProtectedHeader(JSON.parse(canonical(header)))
        .setInitializationVector(randomBytes(12)).encrypt(key);
      checkGeneralHistoryArchive(Buffer.byteLength(archive) <= GENERAL_BACKUP_MAX_BYTES);
      inspectGeneralHistoryArchive(archive);
      return { archive, archiveDigest: header.archiveDigest, archiveCiphertextDigest: createHash("sha256").update(archive, "ascii").digest("hex"), artifactId: job.artifactId };
    }
    key = deriveGeneralHistoryArchiveKey(job.key, plan, job.artifactId);
    const decrypted = await compactDecrypt(job.archive, key, { keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"] });
    plaintext = decrypted.plaintext;
    const archive = validateGeneralBackupArchive(parseGeneralRecoveryRecord(plaintext, GENERAL_BACKUP_MAX_PAYLOAD, "GENERAL_HISTORY_ARCHIVE_INVALID"));
    checkGeneralHistoryArchive(digest(archive) === header.archiveDigest); assertGeneralRestoreArchiveInput(plan, archive);
    return { archive, archiveDigest: header.archiveDigest, archiveCiphertextDigest: createHash("sha256").update(job.archive, "ascii").digest("hex"), artifactId: job.artifactId };
  } catch { return invalidGeneralHistoryArchive(); }
  finally { key?.fill(0); original?.fill(0); plaintext?.fill(0); }
}
