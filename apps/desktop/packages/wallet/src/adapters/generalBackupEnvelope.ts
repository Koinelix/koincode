import { GENERAL_BACKUP_TYPE, GENERAL_BACKUP_MAX_BYTES, GENERAL_BACKUP_MAX_PAYLOAD, invalidGeneralBackup, type GeneralBackupPayload } from "./generalBackupPayload.js";
import { canonical } from "./canonical.js";

export type GeneralBackupJob = { operation: "encrypt_backup"; payload: GeneralBackupPayload; password: string }
  | { operation: "decrypt_backup"; backup: string; password: string };
export type GeneralBackupPreviewJob = { operation: "preview_backup"; backup: string; password: string };
export type GeneralBackupCryptoJob = GeneralBackupJob | GeneralBackupPreviewJob;

export const GENERAL_BACKUP_KDF_COUNT = 600000;
const fail = (ok: unknown) => { if (!ok) return invalidGeneralBackup(); };
function segment(value: string, bytes?: number): Buffer {
  fail(/^[A-Za-z0-9_-]+$/.test(value));
  const result = Buffer.from(value, "base64url");
  fail(result.toString("base64url") === value && (bytes === undefined || result.byteLength === bytes));
  return result;
}

/** Bound untrusted work before password derivation; this does not authenticate an envelope. */
export function inspectGeneralBackupEnvelope(backup: string): void {
  try {
    fail(typeof backup === "string" && backup.length > 0 && Buffer.byteLength(backup) <= GENERAL_BACKUP_MAX_BYTES);
    const parts = backup.split("."); fail(parts.length === 5 && parts[0]!.length <= 1400);
    const headerBytes = segment(parts[0]!);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(headerBytes), header: unknown = JSON.parse(text);
    fail(header && typeof header === "object" && !Array.isArray(header) && JSON.stringify(header) === text);
    const value = header as Record<string, unknown>;
    fail(Object.keys(value).sort().join() === "alg,enc,p2c,p2s,typ" && value.alg === "PBES2-HS512+A256KW" && value.enc === "A256GCM" &&
      value.typ === GENERAL_BACKUP_TYPE && value.p2c === GENERAL_BACKUP_KDF_COUNT && typeof value.p2s === "string");
    segment(value.p2s as string, 16);
    segment(parts[1]!, 40); segment(parts[2]!, 12); segment(parts[4]!, 16);
    fail(parts[3]!.length > 0 && /^[A-Za-z0-9_-]+$/.test(parts[3]!));
    // The ciphertext is bounded above. Re-encoding also rejects ambiguous unused bits.
    const ciphertext = segment(parts[3]!); ciphertext.fill(0);
  } catch { return invalidGeneralBackup(); }
}

export function generalBackupPassword(password: string): Uint8Array {
  try {
    fail(typeof password === "string");
    const normalized = password.normalize("NFKC"), bytes = Buffer.from(normalized, "utf8");
    if (Array.from(normalized).length < 16 || bytes.byteLength > 256 || new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== normalized) {
      bytes.fill(0); return invalidGeneralBackup();
    }
    return bytes;
  } catch { return invalidGeneralBackup(); }
}

/** Cheap admission checks for both the parent and worker; no KDF or material decryption occurs here. */
export function assertGeneralBackupJobInput(job: GeneralBackupCryptoJob): void {
  try {
    fail(job && typeof job === "object" && !Array.isArray(job));
    const encrypt = job.operation === "encrypt_backup";
    fail((encrypt || job.operation === "decrypt_backup" || job.operation === "preview_backup") &&
      Object.keys(job).sort().join() === (encrypt ? "operation,password,payload" : "backup,operation,password"));
    if (encrypt) fail(job.payload && typeof job.payload === "object" && Buffer.byteLength(canonical(job.payload)) <= GENERAL_BACKUP_MAX_PAYLOAD);
    else inspectGeneralBackupEnvelope(job.backup);
    const password = generalBackupPassword(job.password); password.fill(0);
  } catch { return invalidGeneralBackup(); }
}
