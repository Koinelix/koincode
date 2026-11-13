import { z } from "zod";
import { WalletError } from "../domain/errors.js";
import { canonical } from "./canonical.js";

export const generalRecoveryId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const generalRecoveryHash = z.string().regex(/^[0-9a-f]{64}$/);
export const generalRecoveryInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const generalRecoveryUid = z.number().int().min(1).max(4294967294);

export function invalidGeneralRecovery(code: string): never {
  throw new WalletError(code, "The general wallet recovery record could not be verified.");
}

export function checkGeneralRecovery(condition: unknown, code: string): asserts condition {
  if (!condition) invalidGeneralRecovery(code);
}

export function checkGeneralRecoverySize(value: unknown, maximum: number, code: string): void {
  try { checkGeneralRecovery(Buffer.byteLength(canonical(value)) <= maximum, code); }
  catch { invalidGeneralRecovery(code); }
}

/** Canonical bytes are a format check, never evidence of native provenance. */
export function parseGeneralRecoveryRecord(bytes: Uint8Array, maximum: number, code: string): unknown {
  try {
    checkGeneralRecovery(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= maximum, code);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    checkGeneralRecovery(canonical(value) === text, code);
    return value;
  } catch { return invalidGeneralRecovery(code); }
}

/** Same-phase readback is idempotent; exactly one forward phase is allowed per transition. */
export function assertGeneralRecoveryPhase(previous: string, next: string, phases: readonly string[], code: string): void {
  const index = phases.indexOf(previous), following = phases.indexOf(next);
  checkGeneralRecovery(index >= 0 && (following === index || following === index + 1), code);
}
