import type { ClientHandle } from "./sessions.js";
import { requireWallet } from "../domain/errors.js";
export interface PeerIdentityReport {
  platform: "darwin";
  kernelBound: true;
  pid: number;
  uid: number;
  valid: boolean;
  identityKey: string | null;
  hardened: boolean;
  riskyEntitlements: boolean;
  interpreter: boolean;
  classification: "token_only";
}
declare const proofBrand: unique symbol;
export type PeerIdentityProof = { readonly [proofBrand]: true };
const proofs = new WeakMap<
  PeerIdentityProof,
  { handle: ClientHandle; report: PeerIdentityReport }
>();
// Private adapter authority: this function is not exported through the public wallet entrypoints.
export function recordKernelPeer(
  handle: ClientHandle,
  report: PeerIdentityReport,
): PeerIdentityProof {
  const proof = Object.freeze({}) as PeerIdentityProof;
  proofs.set(proof, { handle, report: structuredClone(report) });
  return proof;
}
export function requirePeer(proof: PeerIdentityProof, handle: ClientHandle): PeerIdentityReport {
  const entry = proofs.get(proof);
  requireWallet(
    entry && entry.handle === handle,
    "CLIENT_AUTHENTICATION_REQUIRED",
    "The peer proof does not belong to this authenticated connection.",
  );
  return structuredClone(entry.report);
}
