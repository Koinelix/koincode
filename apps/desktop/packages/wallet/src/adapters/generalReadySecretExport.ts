import { generalDerivationIndex } from "../domain/generalDerivation.js";
import { performance } from "node:perf_hooks";
import type { ProtectedStore } from "../app/ports.js";
import { generalSourceCommitment, type GeneralKeySource } from "../app/generalState.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import type { GeneralGuardedState } from "./generalGuardedState.js";
import type { GeneralSecretJob } from "./generalSecretCrypto.js";
import { previewGeneralMnemonic, previewGeneralPrivateKey } from "./generalKeyPreview.js";

export type GeneralExportFormat = "mnemonic" | "private_key";
export type GeneralExportBinding = Readonly<{ sourceId: string; setupId: string; sourceCommitment: string; format: GeneralExportFormat }>;
export type GeneralSecretExport = { format: "mnemonic"; phrase: string } | { format: "private_key"; privateKey: string };

export function assertGeneralSecretExport(result: unknown, address: string, format: GeneralExportFormat, derivationPath?: string): GeneralSecretExport {
  try {
    requireWallet(format === "mnemonic" || format === "private_key", "GENERAL_SECRET_INVALID", "The protected wallet material is invalid.");
    const field = format === "mnemonic" ? "phrase" : "privateKey";
    requireWallet(result && typeof result === "object" && !Array.isArray(result) && Object.keys(result).join() === field,
      "GENERAL_SECRET_INVALID", "The protected wallet material is invalid.");
    const value = (result as Record<string, unknown>)[field];
    requireWallet(typeof value === "string" && Buffer.byteLength(value) <= 1024,
      "GENERAL_SECRET_INVALID", "The protected wallet material is invalid.");
    if (format === "mnemonic") requireWallet(value === value.normalize("NFKD").trim().toLowerCase().split(/\s+/).join(" "),
      "GENERAL_SECRET_INVALID", "The protected wallet material is invalid.");
    else requireWallet(/^0x[0-9a-f]{64}$/.test(value), "GENERAL_SECRET_INVALID", "The protected wallet material is invalid.");
    const preview = format === "mnemonic" ? previewGeneralMnemonic(value, generalDerivationIndex(derivationPath)) : previewGeneralPrivateKey(value);
    requireWallet(preview.address.toLowerCase() === address.toLowerCase(), "GENERAL_SECRET_INVALID", "The protected wallet material is invalid.");
    return format === "mnemonic" ? { format, phrase: value } : { format, privateKey: value };
  } catch { throw new WalletError("GENERAL_SECRET_INVALID", "The protected wallet material is invalid."); }
}

/** Internal only. The admitted owner supplies authentication and the sensitive window lifetime. */
export async function exportGeneralReadySecret(input: {
  state: GeneralGuardedState; protection: ProtectedStore; source: GeneralKeySource; signal: AbortSignal; format: GeneralExportFormat;
  admission: () => void; authorize: (binding: GeneralExportBinding, signal: AbortSignal) => Promise<boolean>;
  crypto: (job: GeneralSecretJob, signal?: AbortSignal) => Promise<unknown>;
}): Promise<GeneralSecretExport> {
  const initial = input.state.snapshot(), source = structuredClone(input.source), commitment = generalSourceCommitment(source);
  const controller = new AbortController(), deadline = performance.now() + 60000;
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 60000);
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  const current = () => {
    input.admission();
    requireWallet(!controller.signal.aborted && performance.now() < deadline && input.state.isLive(initial.ownerId, initial.installationId),
      "GENERAL_OPERATION_CANCELED", "The wallet operation was canceled.");
    const state = input.state.snapshot(), live = state.sources.find((item) => item.id === source.id);
    requireWallet(live?.status === "ready" && generalSourceCommitment(live) === commitment &&
      state.setups.some((setup) => setup.id === live.setupId && setup.phase === "ready"),
    "GENERAL_ACCOUNT_UNAVAILABLE", "The wallet source is unavailable.");
    requireWallet(input.format === "private_key" || live.sourceType === "mnemonic",
      "GENERAL_MNEMONIC_UNAVAILABLE", "The mnemonic source is unavailable.");
  };
  let key: Uint8Array | null = null;
  let cancelAuth: (() => void) | undefined;
  try {
    requireWallet(input.format === "mnemonic" || input.format === "private_key", "INVALID_REQUEST", "The export format is invalid.");
    current();
    const canceled = new Promise<boolean>((resolve) => {
      cancelAuth = () => resolve(false);
      controller.signal.addEventListener("abort", cancelAuth, { once: true });
    });
    let authorized = false;
    try {
      authorized = await Promise.race([Promise.resolve().then(() => input.authorize(Object.freeze({ sourceId: source.id,
        setupId: source.setupId, sourceCommitment: commitment, format: input.format }), controller.signal)), canceled]) === true;
    } catch { /* Authentication provider details never cross the secret boundary. */ }
    current();
    requireWallet(authorized, "GENERAL_AUTH_REQUIRED", "System authentication is required.");
    try { key = await input.protection.get(source.keyRef); }
    catch { throw new WalletError("GENERAL_STORE_UNAVAILABLE", "The protected source key is unavailable."); }
    current();
    requireWallet(key instanceof Uint8Array && key.byteLength === 32, "GENERAL_STORE_UNAVAILABLE", "The protected source key is unavailable.");
    const identity = { ownerId: initial.ownerId, keySourceId: source.id, key, address: source.address, derivationPath: source.derivationPath };
    const result = await input.crypto(input.format === "mnemonic" ? { ...identity, operation: "reveal", envelope: source.protectedMaterial }
      : { ...identity, operation: "export_private_key", sourceType: source.sourceType, protectedMaterial: source.protectedMaterial }, controller.signal);
    current();
    const exported = assertGeneralSecretExport(result, source.address, input.format, source.derivationPath);
    current();
    return exported;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", abort);
    if (cancelAuth) controller.signal.removeEventListener("abort", cancelAuth);
    controller.abort();
    key?.fill(0);
  }
}
