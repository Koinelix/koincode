import { z } from "zod";
import { canonical } from "./canonical.js";
import { GENERAL_BACKUP_MAX_PAYLOAD, invalidGeneralBackup, validateGeneralBackupArchive, type GeneralBackupArchive } from "./generalBackupPayload.js";

const schema = z.strictObject({ format: z.literal("koincode-general-restore-preview"), version: z.literal(1),
  backupId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  payloadDigest: z.string().regex(/^[0-9a-f]{64}$/), createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  archive: z.unknown() });

/** Privacy-bearing worker output, not a native admission capability or a public account projection. */
export type GeneralBackupPreview = Omit<z.infer<typeof schema>, "archive"> & { archive: GeneralBackupArchive };

/** Structural validation does not authenticate caller-supplied previews or prove current continuity. */
export function validateGeneralBackupPreview(value: unknown): GeneralBackupPreview {
  try {
    if (Buffer.byteLength(canonical(value)) > GENERAL_BACKUP_MAX_PAYLOAD) return invalidGeneralBackup();
    const row = schema.parse(value);
    return { ...row, archive: validateGeneralBackupArchive(row.archive) };
  } catch { return invalidGeneralBackup(); }
}
