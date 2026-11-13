import type { GeneralSetupMode } from "../domain/generalSetup.js";
import type { GeneralExportBinding } from "./generalReadySecretExport.js";
import { digest } from "./canonical.js";
import { WalletError } from "../domain/errors.js";
export type GeneralSetupAuthorization = Readonly<{ ownerId: string; installationId: string; setupId: string; mode: GeneralSetupMode; inputBinding: string }>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Public command binding only. Native peer/window/Root/scope verification and
 * actual human authentication remain independent requirements. */
export function generalSetupAuthenticationScope(binding: GeneralSetupAuthorization): { action: string; operationDigest: string; accountAddress: null } {
  if (!binding || Object.keys(binding).sort().join() !== "inputBinding,installationId,mode,ownerId,setupId" ||
      !uuid.test(binding.ownerId) || !uuid.test(binding.installationId) || !uuid.test(binding.setupId) ||
      !/^[0-9a-f]{64}$/.test(binding.inputBinding) || !["create", "import_mnemonic", "import_private_key"].includes(binding.mode))
    throw new WalletError("INVALID_REQUEST", "The setup authentication scope is invalid.");
  return { action: binding.mode === "create" ? "create_wallet" : binding.mode,
    operationDigest: digest({ format: "koincode-general-setup-operation", version: 1, ...binding }), accountAddress: null };
}

/** The scope digest binds one source, material commitment and output format without carrying secrets. */
export function generalExportAuthenticationScope(binding: GeneralExportBinding, address: string): { action: string; operationDigest: string; accountAddress: string } {
  if (!binding || Object.keys(binding).sort().join() !== "format,setupId,sourceCommitment,sourceId" ||
      !uuid.test(binding.sourceId) || !uuid.test(binding.setupId) || !/^[0-9a-f]{64}$/.test(binding.sourceCommitment) ||
      !["mnemonic", "private_key"].includes(binding.format) || !/^0x[0-9a-f]{40}$/.test(address))
    throw new WalletError("INVALID_REQUEST", "The secret export scope is invalid.");
  return { action: binding.format === "mnemonic" ? "reveal_mnemonic" : "export_private_key",
    operationDigest: digest({ format: "koincode-general-secret-export", version: 1, source: binding, address }), accountAddress: address };
}

/** Invokes the original trusted owner's callback; never a renderer result or
 * a native admission proof. Component-only callers retain their old fallback. */
export function requestGeneralSetupAuthentication(port: {
  authorizeSetup?(binding: GeneralSetupAuthorization, signal: AbortSignal): Promise<boolean>;
  authorizeReveal(setupId: string): Promise<boolean>;
}, identity: { ownerId: string; installationId: string }, setup: Pick<GeneralSetupAuthorization, "setupId" | "mode" | "inputBinding">,
signal: AbortSignal, resume = false): Promise<boolean> {
  if (!port.authorizeSetup) return resume ? port.authorizeReveal(setup.setupId) : Promise.resolve(true);
  return port.authorizeSetup(Object.freeze({ ownerId: identity.ownerId, installationId: identity.installationId,
    setupId: setup.setupId, mode: setup.mode, inputBinding: setup.inputBinding }), signal);
}
