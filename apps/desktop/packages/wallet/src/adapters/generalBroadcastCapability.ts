import type { GeneralSigningRisk } from "../app/generalSigningTypes.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { assertGeneralBoundedManualFee } from "../domain/generalSigningPolicy.js";
import { GENERAL_SIGNING_POLICY_DIGEST, GENERAL_SIGNING_POLICY_VERSION } from "../domain/generalSigningPolicy.js";
import { assertGeneralSigningPolicy } from "../app/generalSigningPolicyVerification.js";
import { inspectGeneralSignedMaterial } from "./generalSignedMaterial.js";
import type { GeneralTransferPreview } from "./generalTransferIntent.js";

const permits = new WeakMap<object, { ownerId: string; risk: GeneralSigningRisk; transactionHash: string; issuedAt: number; isLive: () => boolean; now: () => number }>();

/** Issued only after the journal has durably recorded this exact signed transaction. */
export function issueGeneralBroadcastPermit(ownerId: string, risk: GeneralSigningRisk, transactionHash: string,
  isLive: () => boolean, now: () => number): object {
  const permit = Object.freeze({});
  permits.set(permit, { ownerId, risk: structuredClone(risk), transactionHash, issuedAt: now(), isLive, now });
  return permit;
}

/** The permit is consumed before any outbound send and cannot authorize a replacement or retry. */
export function consumeGeneralBroadcastPermit(permit: object, preview: GeneralTransferPreview, riskId: string, signedTransaction: string): string {
  const value = permit && typeof permit === "object" ? permits.get(permit) : undefined;
  if (permit && typeof permit === "object") permits.delete(permit);
  requireWallet(value, "SIGNING_CONTINUITY_UNKNOWN", "A protected broadcast capability is required.");
  assertGeneralSigningPolicy();
  requireWallet(preview && preview.signingPolicyVersion === GENERAL_SIGNING_POLICY_VERSION && preview.signingPolicyDigest === GENERAL_SIGNING_POLICY_DIGEST,
    "SIGNING_CONTINUITY_UNKNOWN", "The broadcast signing policy is unavailable.");
  let live = false, current = -1;
  try { live = value.isLive() === true; current = value.now(); } catch { /* unavailable owner or clock */ }
  requireWallet(live && Number.isSafeInteger(value.issuedAt) && Number.isSafeInteger(current) && current >= value.issuedAt && current < value.risk.approvalExpiresAt,
    "TRANSFER_APPROVAL_EXPIRED", "The transfer approval is unavailable or expired.");
  const risk = value.risk, asset = preview.asset.kind === "native" ? "native" : `erc20:${preview.asset.address}`;
  requireWallet(value.ownerId === preview.ownerId && risk.riskId === riskId && risk.transferId === preview.transferId &&
    risk.intentDigest === preview.digest && risk.accountAddress === preview.accountAddress && risk.networkId === preview.networkId &&
    risk.nonce === preview.nonce && risk.asset === asset && risk.amountAtomic === preview.amountAtomic &&
    risk.maxGasAtomic === preview.maxFeeExposureAtomic && risk.approvalExpiresAt === preview.expiresAt,
  "SIGNING_CONTINUITY_CONFLICT", "The broadcast capability does not match the transaction.");
  assertGeneralBoundedManualFee(preview.networkId);
  const inspected = inspectGeneralSignedMaterial(preview, risk.intentDigest, riskId, signedTransaction);
  if (inspected.transactionHash !== value.transactionHash) throw new WalletError("SIGNING_CONTINUITY_CONFLICT", "The signed transaction hash changed.");
  return value.transactionHash;
}
