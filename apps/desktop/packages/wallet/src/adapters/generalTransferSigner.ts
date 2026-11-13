import { requireWallet } from "../domain/errors.js";
import { runGeneralSignTask } from "./generalCryptoTask.js";
import type { GeneralSecretJob } from "./generalSecretCrypto.js";
import { GeneralSignedMaterialStore } from "./generalSignedMaterial.js";
import { GeneralSigningJournal } from "./generalSigningJournal.js";
import type { GeneralTransferPreview } from "./generalTransferIntent.js";

const broadcasts = new WeakMap<object, { permit: object; preview: GeneralTransferPreview; digest: string; riskId: string; material: GeneralSignedMaterialStore }>();

/** Internal owner operation. Signed bytes are retained only in protected storage, never returned to the caller. */
export async function signAndProtectGeneralTransfer(input: {
  job: Extract<GeneralSecretJob, { operation: "sign_transaction" }>;
  permit: object;
  journal: GeneralSigningJournal;
  material: GeneralSignedMaterialStore;
  signal?: AbortSignal;
}): Promise<{ transactionHash: string }> {
  const preview = structuredClone(input.job.preview), digest = input.job.approvedDigest, riskId = input.job.riskId;
  const signed = await runGeneralSignTask<unknown>(input.job, input.permit, input.signal);
  requireWallet(signed && typeof signed === "object" && !Array.isArray(signed) &&
    Object.keys(signed).sort().join() === "signedTransaction,transactionHash" &&
    "signedTransaction" in signed && typeof signed.signedTransaction === "string" &&
    "transactionHash" in signed && typeof signed.transactionHash === "string" && /^0x[0-9a-f]{64}$/.test(signed.transactionHash),
  "GENERAL_SECRET_INVALID", "The signing result is invalid.");
  // Once signing may have happened, cancellation must not discard recoverable signed bytes.
  const saved = await input.material.putForJournal(preview, digest, riskId, signed.signedTransaction);
  requireWallet(saved.transactionHash === signed.transactionHash, "GENERAL_SIGNED_MATERIAL_INVALID", "The signed transaction hash is inconsistent.");
  const permit = await input.journal.recordSigned(riskId, saved.transactionHash, saved.proof);
  requireWallet(!input.signal?.aborted, "GENERAL_OPERATION_CANCELED", "The wallet operation was canceled.");
  requireWallet(permit, "SIGNING_CONTINUITY_UNKNOWN", "The broadcast capability is unavailable.");
  const result = Object.freeze({ transactionHash: saved.transactionHash });
  broadcasts.set(result, { permit, preview, digest, riskId, material: input.material });
  return result;
}

/** The result identity remains private to the owner and permits at most one initial attempt. */
export function takeGeneralBroadcastResult(result: object): { permit: object; preview: GeneralTransferPreview; digest: string; riskId: string; material: GeneralSignedMaterialStore } {
  const value = result && typeof result === "object" ? broadcasts.get(result) : undefined;
  if (result && typeof result === "object") broadcasts.delete(result);
  requireWallet(value, "SIGNING_CONTINUITY_UNKNOWN", "The original broadcast capability is unavailable.");
  return value;
}
