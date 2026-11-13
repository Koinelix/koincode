import { createHash, randomBytes } from "node:crypto";
import { CompactEncrypt, compactDecrypt } from "jose";
import { withBackupCrypto } from "./backupKeyWrap.js";
import { canonical } from "./canonical.js";
import { GENERAL_BACKUP_TYPE, GENERAL_BACKUP_MAX_BYTES, GENERAL_BACKUP_MAX_PAYLOAD,
  generalBackupArchiveSnapshot, invalidGeneralBackup, parseGeneralBackupPayload, validateGeneralBackupPayload, type GeneralBackupPayload } from "./generalBackupPayload.js";
import { GENERAL_BACKUP_KDF_COUNT, generalBackupPassword, inspectGeneralBackupEnvelope, assertGeneralBackupJobInput, type GeneralBackupCryptoJob } from "./generalBackupEnvelope.js";
import { verifyGeneralBackupMaterials } from "./generalBackupMaterials.js";
import { validateGeneralBackupPreview, type GeneralBackupPreview } from "./generalBackupPreview.js";

export type { GeneralBackupJob } from "./generalBackupEnvelope.js";
export type GeneralBackupEncrypted = { backup: string; payloadDigest: string };
/** Secret-bearing result. Only the protected restore owner may receive it; never a renderer, SDK or model. */
export type GeneralBackupDecrypted = { payload: GeneralBackupPayload; payloadDigest: string };

/** A bounded worker executes this primitive; constructing a job does not confer native export or restore authority. */
export async function executeGeneralBackupJob(job: GeneralBackupCryptoJob): Promise<GeneralBackupEncrypted | GeneralBackupDecrypted | GeneralBackupPreview> {
  try {
    assertGeneralBackupJobInput(job);
    const password = generalBackupPassword(job.password);
    try {
      return await withBackupCrypto(async () => {
        if (job.operation === "encrypt_backup") {
          const payload = validateGeneralBackupPayload(job.payload);
          await verifyGeneralBackupMaterials(payload);
          const plaintext = Buffer.from(canonical(payload));
          try {
            if (plaintext.byteLength > GENERAL_BACKUP_MAX_PAYLOAD) return invalidGeneralBackup();
            const payloadDigest = createHash("sha256").update(plaintext).digest("hex");
            const backup = await new CompactEncrypt(plaintext).setProtectedHeader({ alg: "PBES2-HS512+A256KW", enc: "A256GCM", typ: GENERAL_BACKUP_TYPE })
              .setKeyManagementParameters({ p2c: GENERAL_BACKUP_KDF_COUNT, p2s: randomBytes(16) }).encrypt(password);
            if (Buffer.byteLength(backup) > GENERAL_BACKUP_MAX_BYTES) return invalidGeneralBackup();
            inspectGeneralBackupEnvelope(backup);
            return { backup, payloadDigest };
          } finally { plaintext.fill(0); }
        }
        const { plaintext } = await compactDecrypt(job.backup, password, {
          keyManagementAlgorithms: ["PBES2-HS512+A256KW"], contentEncryptionAlgorithms: ["A256GCM"], maxPBES2Count: GENERAL_BACKUP_KDF_COUNT,
        });
        let payload: GeneralBackupPayload | undefined;
        try {
          payload = parseGeneralBackupPayload(plaintext);
          await verifyGeneralBackupMaterials(payload);
          const payloadDigest = createHash("sha256").update(plaintext).digest("hex");
          if (job.operation === "preview_backup") return validateGeneralBackupPreview({ format: "koincode-general-restore-preview", version: 1,
            backupId: payload.backupId, payloadDigest, createdAt: payload.createdAt, archive: generalBackupArchiveSnapshot(payload) });
          return { payload, payloadDigest };
        } finally {
          if (job.operation === "preview_backup" && payload) {
            for (const row of payload.wrappingKeys) row.key = "";
            payload.wrappingKeys.length = 0;
          }
          plaintext.fill(0);
        }
      });
    } finally { password.fill(0); }
  } catch { return invalidGeneralBackup(); }
}
