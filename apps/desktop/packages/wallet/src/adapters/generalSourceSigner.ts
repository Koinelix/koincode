import { generalSourceCommitment, type GeneralKeySource } from "../app/generalState.js";
import type { ProtectedStore } from "../app/ports.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { GeneralGuardedState } from "./generalGuardedState.js";
import { GeneralSignedMaterialStore } from "./generalSignedMaterial.js";
import { assertGeneralSignerPermit, revokeGeneralSignerPermit } from "./generalSigningCapability.js";
import { GeneralSigningJournal } from "./generalSigningJournal.js";
import type { GeneralTransferPreview } from "./generalTransferIntent.js";
import { signAndProtectGeneralTransfer } from "./generalTransferSigner.js";

const attempted = new WeakSet<object>();

function readySource(owner: GeneralGuardedState, preview: GeneralTransferPreview): { source: GeneralKeySource; installationId: string } {
  const state = owner.snapshot(), source = state.sources.find((item) => item.id === preview.accountId);
  requireWallet(state.ownerId === preview.ownerId && source?.status === "ready" && source.address === preview.accountAddress &&
    state.setups.some((item) => item.id === source.setupId && item.phase === "ready"),
  "GENERAL_ACCOUNT_UNAVAILABLE", "A ready general wallet account is required.");
  return { source, installationId: state.installationId };
}

/** Internal utility operation. Only a journal-bound permit may access the selected ready source. */
export async function signGeneralReadySource(input: {
  owner: GeneralGuardedState; protection: ProtectedStore; journal: GeneralSigningJournal; material: GeneralSignedMaterialStore;
  preview: GeneralTransferPreview; riskId: string; permit: object; signal?: AbortSignal;
}): Promise<{ transactionHash: string }> {
  requireWallet(input.permit && typeof input.permit === "object" && !attempted.has(input.permit),
    "SIGNING_CONTINUITY_UNKNOWN", "A fresh signing capability is required.");
  attempted.add(input.permit);
  try { return await signSelectedSource(input); }
  finally { revokeGeneralSignerPermit(input.permit); }
}

async function signSelectedSource(input: Parameters<typeof signGeneralReadySource>[0]): Promise<{ transactionHash: string }> {
  const preview = structuredClone(input.preview);
  assertGeneralSignerPermit(input.permit, preview, input.riskId);
  const selected = readySource(input.owner, preview), commitment = generalSourceCommitment(selected.source);
  const keySignal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
  if (keySignal.aborted) throw new WalletError("GENERAL_OPERATION_CANCELED", "The wallet operation was canceled.");
  let onAbort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(new WalletError("GENERAL_OPERATION_CANCELED", "The wallet operation was canceled."));
    keySignal.addEventListener("abort", onAbort, { once: true });
    if (keySignal.aborted) onAbort();
  });
  const pending = Promise.resolve().then(() => input.protection.get(selected.source.keyRef)).then((value) => {
    if (keySignal.aborted || !input.owner.isLive(preview.ownerId, selected.installationId)) {
      if (value instanceof Uint8Array) value.fill(0);
      throw new WalletError("GENERAL_OPERATION_CANCELED", "The wallet operation was canceled.");
    }
    return value;
  }, () => { throw new WalletError("GENERAL_STORE_UNAVAILABLE", "The protected source key is unavailable."); });
  let key: Uint8Array | null = null;
  try {
    key = await Promise.race([pending, stopped]);
    requireWallet(key instanceof Uint8Array && key.byteLength === 32, "GENERAL_STORE_UNAVAILABLE", "The protected source key is unavailable.");
    const current = readySource(input.owner, preview);
    requireWallet(current.installationId === selected.installationId && generalSourceCommitment(current.source) === commitment && !keySignal.aborted,
      "GENERAL_ACCOUNT_UNAVAILABLE", "The general wallet account changed.");
    assertGeneralSignerPermit(input.permit, preview, input.riskId);
    return await signAndProtectGeneralTransfer({ job: { operation: "sign_transaction", ownerId: preview.ownerId,
      keySourceId: current.source.id, key, derivationPath: current.source.derivationPath, sourceType: current.source.sourceType, address: current.source.address,
      protectedMaterial: current.source.protectedMaterial, preview, approvedDigest: preview.digest, riskId: input.riskId },
    permit: input.permit, journal: input.journal, material: input.material, signal: input.signal });
  } finally {
    keySignal.removeEventListener("abort", onAbort);
    if (key instanceof Uint8Array) key.fill(0);
  }
}
