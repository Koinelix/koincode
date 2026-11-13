import { createHash, timingSafeEqual } from "node:crypto";
import type { ProtectedStore } from "../app/ports.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical, digest } from "./canonical.js";
import { validateGeneralBackupPayload } from "./generalBackupPayload.js";
import type { GeneralBackupDecrypted, GeneralBackupJob } from "./generalBackupCrypto.js";
import { assertGeneralRestorePlanInput, type GeneralRestorePlan } from "./generalRestorePlan.js";

export type GeneralRestoreKeyAdmission = { admitKey(input: Readonly<{ recoveryId: string; planDigest: string; reference: string; keyDigest: string }>,
  signal: AbortSignal): Promise<void> };
type Job = Extract<GeneralBackupJob, { operation: "decrypt_backup" }>;
type Ports = { protection: ProtectedStore; current(): void; readPlan(): Promise<GeneralRestorePlan | null>;
  decrypt(job: Job, signal: AbortSignal): Promise<GeneralBackupDecrypted>;
  admitKey: GeneralRestoreKeyAdmission["admitKey"];
  markUncertain(reference: string): void; uncertain(reference: string): never;
  /** Record-session crypto executor only; the artifact IO port never receives this payload. */
  encryptArchive?(payload: ReturnType<typeof validateGeneralBackupPayload>, plan: GeneralRestorePlan, signal: AbortSignal): Promise<void>;
  advance(previous: GeneralRestorePlan, next: GeneralRestorePlan): Promise<GeneralRestorePlan> };
const conflict = () => new WalletError("GENERAL_RECOVERY_RECORD_CONFLICT", "The original restore material could not be verified.");

function clearKeys(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const rows = (input as Record<string, unknown>).wrappingKeys;
  if (!Array.isArray(rows)) return;
  for (const row of rows.slice(0, 1256)) if (row && typeof row === "object") {
    try { Reflect.set(row, "key", ""); } catch { /* Unusable worker data never becomes restore authority. */ }
  }
}
function equalKey(input: Uint8Array | null, expected: Uint8Array): boolean {
  return input instanceof Uint8Array && input.byteLength === 32 && timingSafeEqual(input, expected);
}

/** Executes inside the existing recovery-record command slot; owns no independent queue or native authority. */
export async function stageGeneralRestoreKeys(original: GeneralRestorePlan, job: Job, ports: Ports, signal: AbortSignal): Promise<GeneralRestorePlan> {
  let decrypted: GeneralBackupDecrypted | undefined, payload: ReturnType<typeof validateGeneralBackupPayload> | undefined;
  let keys: Map<string, string> | undefined;
  const readOriginal = async () => {
    ports.current(); const plan = await ports.readPlan(); ports.current();
    requireWallet(plan && canonical({ ...plan, phase: original.phase }) === canonical(original),
      "GENERAL_RECOVERY_RECORD_CONFLICT", "The same protected restore plan is required.");
    return plan;
  };
  try {
    const stored = await readOriginal();
    try { decrypted = await ports.decrypt(job, signal); } catch (error) { ports.current(); throw error; }
    ports.current();
    requireWallet(decrypted && typeof decrypted === "object" && !Array.isArray(decrypted) &&
      Object.keys(decrypted).sort().join() === "payload,payloadDigest", "GENERAL_BACKUP_INVALID", "The backup worker response is invalid.");
    payload = validateGeneralBackupPayload(decrypted.payload);
    requireWallet(decrypted.payloadDigest === digest(payload), "GENERAL_BACKUP_INVALID", "The backup worker snapshot does not match.");
    assertGeneralRestorePlanInput(stored, payload);
    keys = new Map(payload.wrappingKeys.map((entry) => [entry.keyRef, entry.key]));
    for (const reference of stored.keyRefs) {
      ports.current(); const expected = Buffer.from(keys.get(reference)!, "base64url");
      let existing: Uint8Array | null = null;
      try {
        existing = await ports.protection.get(reference); ports.current();
        if (existing !== null) {
          if (!equalKey(existing, expected)) { ports.markUncertain(reference); throw conflict(); }
          continue;
        }
        if (stored.phase !== "prepared") { ports.markUncertain(reference); throw conflict(); }
        try {
          const admitted: unknown = await ports.admitKey(Object.freeze({ recoveryId: stored.recoveryId, planDigest: stored.planDigest,
            reference, keyDigest: createHash("sha256").update(expected).digest("hex") }), signal);
          requireWallet(admitted === undefined, "GENERAL_RECOVERY_CREATE_NOT_ADMITTED", "The native material admission response was invalid.");
        } catch { ports.current(); throw new WalletError("GENERAL_RECOVERY_CREATE_NOT_ADMITTED", "The native operation did not admit this material reference."); }
        ports.current();
        try {
          const result: unknown = await ports.protection.put(reference, expected);
          requireWallet(result === undefined, "GENERAL_RECOVERY_RECORD_INVALID", "The material write completion was invalid.");
          // Unlike metadata readback, a new secret read is forbidden after cancellation or scope loss.
          ports.current();
          const checked = await ports.protection.get(reference);
          try { ports.current(); requireWallet(equalKey(checked, expected), "GENERAL_RECOVERY_RECORD_INVALID", "The material readback did not match."); }
          finally { if (checked instanceof Uint8Array) checked.fill(0); }
        } catch { return ports.uncertain(reference); }
      } finally { if (existing instanceof Uint8Array) existing.fill(0); expected.fill(0); }
    }
    if (ports.encryptArchive && (stored.phase === "prepared" || stored.phase === "keys_staged")) {
      ports.current(); const result: unknown = await ports.encryptArchive(payload, stored, signal); ports.current();
      requireWallet(result === undefined, "GENERAL_HISTORY_ARCHIVE_INVALID", "The archive preparation result was invalid.");
    }
    const latest = await readOriginal();
    requireWallet(canonical(latest) === canonical(stored), "GENERAL_RECOVERY_RECORD_CONFLICT", "The restore phase changed during material staging.");
    ports.current();
    return latest.phase === "prepared" ? await ports.advance(latest, { ...latest, phase: "keys_staged" }) : latest;
  } finally { keys?.clear(); clearKeys(decrypted?.payload); clearKeys(payload); job.password = ""; job.backup = ""; }
}
