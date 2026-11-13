import { createHash } from "node:crypto";
import { requireWallet } from "../domain/errors.js";
import { generalSigningPolicyBytes, GENERAL_SIGNING_POLICY_DIGEST, GENERAL_SIGNING_POLICY_VERSION } from "../domain/generalSigningPolicy.js";

/** Exact identity check; equivalent JSON is not the same policy. */
export function verifyGeneralSigningPolicy(bytes: Uint8Array, version: unknown, expectedDigest: unknown): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== generalSigningPolicyBytes().byteLength || version !== GENERAL_SIGNING_POLICY_VERSION || expectedDigest !== GENERAL_SIGNING_POLICY_DIGEST) return false;
  const actual = Buffer.from(bytes), required = Buffer.from(generalSigningPolicyBytes());
  return actual.equals(required) && createHash("sha256").update(actual).digest("hex") === GENERAL_SIGNING_POLICY_DIGEST;
}

export function assertGeneralSigningPolicy(): void {
  requireWallet(verifyGeneralSigningPolicy(generalSigningPolicyBytes(), GENERAL_SIGNING_POLICY_VERSION, GENERAL_SIGNING_POLICY_DIGEST),
    "SIGNING_CONTINUITY_UNKNOWN", "The general signing policy cannot be verified.");
}
