import { performance } from "node:perf_hooks";
import { WalletError, requireWallet } from "../domain/errors.js";
import { assertGeneralTransferPreview, type GeneralTransferPreview } from "./generalTransferIntent.js";
import type { GeneralSigningRisk } from "../app/generalSigningTypes.js";
import { assertGeneralBoundedManualFee } from "../domain/generalSigningPolicy.js";

const capabilities = new WeakMap<object, { ownerId: string; risk: GeneralSigningRisk; isLive: () => boolean }>();
export type GeneralEvidenceLifetime = { startedAt: number; expiresAt: number; isLive: () => boolean };
export function generalEvidenceIsLive(proof: GeneralEvidenceLifetime, now: number): boolean {
  try { return Number.isSafeInteger(now) && now >= proof.startedAt && now < proof.expiresAt && proof.isLive(); }
  catch { return false; }
}

/** Internal journal-only issuance, never exposed through the desktop or model-facing contract. */
export function issueGeneralSignerPermit(ownerId: string, risk: GeneralSigningRisk, isLive: () => boolean,
  proof: GeneralEvidenceLifetime, now: () => number): object {
  const ticket = Object.freeze({});
  capabilities.set(ticket, { ownerId, risk: structuredClone(risk), isLive: () => isLive() && generalEvidenceIsLive(proof, now()) });
  return ticket;
}

type SignerCapability = NonNullable<ReturnType<typeof capabilities.get>>;
function validate(capability: SignerCapability | undefined, preview: GeneralTransferPreview, riskId: string): void {
  requireWallet(capability, "SIGNING_CONTINUITY_UNKNOWN", "A protected signing capability is required.");
  let live = false;
  try { live = capability.isLive() === true; } catch { /* An unavailable owner is never valid. */ }
  requireWallet(live, "SIGNING_CONTINUITY_UNKNOWN", "The signing owner is unavailable.");
  const risk = capability.risk, asset = preview.asset.kind === "native" ? "native" : `erc20:${preview.asset.address}`;
  requireWallet(capability.ownerId === preview.ownerId && risk.riskId === riskId && risk.transferId === preview.transferId &&
    risk.intentDigest === preview.digest && risk.accountAddress === preview.accountAddress && risk.networkId === preview.networkId &&
    risk.nonce === preview.nonce && risk.asset === asset && risk.amountAtomic === preview.amountAtomic &&
    risk.maxGasAtomic === preview.maxFeeExposureAtomic && risk.approvalExpiresAt === preview.expiresAt,
  "SIGNING_CONTINUITY_CONFLICT", "The protected signing capability does not match the transfer.");
  try {
    assertGeneralTransferPreview(preview, risk.intentDigest, Math.floor(performance.now()));
    assertGeneralBoundedManualFee(preview.networkId);
  }
  catch (error) {
    if (error instanceof WalletError) throw error;
    throw new WalletError("SIGNING_CONTINUITY_UNKNOWN", "The signing capability is invalid.");
  }
}

/** Check before protected key access; any failed check permanently revokes the capability. */
export function assertGeneralSignerPermit(ticket: object, preview: GeneralTransferPreview, riskId: string): void {
  const capability = ticket && typeof ticket === "object" ? capabilities.get(ticket) : undefined;
  try { validate(capability, preview, riskId); }
  catch (error) { if (ticket && typeof ticket === "object") capabilities.delete(ticket); throw error; }
}

export function revokeGeneralSignerPermit(ticket: object): void {
  if (ticket && typeof ticket === "object") capabilities.delete(ticket);
}

/** Consume before spawning a signer. A forged, cloned, expired or changed permit cannot be retried. */
export function consumeGeneralSignerPermit(ticket: object, preview: GeneralTransferPreview, riskId: string): void {
  const capability = ticket && typeof ticket === "object" ? capabilities.get(ticket) : undefined;
  if (ticket && typeof ticket === "object") capabilities.delete(ticket);
  validate(capability, preview, riskId);
}
