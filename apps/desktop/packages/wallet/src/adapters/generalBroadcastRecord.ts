import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical, digest } from "./canonical.js";
import type { GeneralTransferPreview } from "./generalTransferIntent.js";

export type GeneralBroadcastStatus = "BROADCAST_POSSIBLE" | "SUBMITTED" | "UNKNOWN";
export type GeneralBroadcastRecord = { format: "koincode-general-broadcast"; version: 1; ownerId: string; transferId: string;
  riskId: string; intentDigest: string; networkId: string; transactionHash: string; status: GeneralBroadcastStatus };

export function generalBroadcastRecord(preview: GeneralTransferPreview, approvedDigest: string, riskId: string,
  transactionHash: string, status: GeneralBroadcastStatus): GeneralBroadcastRecord {
  const { digest: actual, ...fields } = preview;
  requireWallet(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(riskId) &&
    /^[0-9a-f]{64}$/.test(approvedDigest) && actual === approvedDigest && digest(fields) === actual &&
    /^0x[0-9a-f]{64}$/.test(transactionHash) && ["BROADCAST_POSSIBLE", "SUBMITTED", "UNKNOWN"].includes(status),
  "GENERAL_BROADCAST_INVALID", "The broadcast record identity is invalid.");
  return { format: "koincode-general-broadcast", version: 1, ownerId: preview.ownerId, transferId: preview.transferId,
    riskId, intentDigest: approvedDigest, networkId: preview.networkId, transactionHash, status };
}

export function parseGeneralBroadcastRecord(bytes: Uint8Array, preview: GeneralTransferPreview, approvedDigest: string,
  riskId: string, transactionHash: string): GeneralBroadcastRecord {
  try {
    requireWallet(bytes.byteLength <= 4096, "GENERAL_BROADCAST_INVALID", "The broadcast record is invalid.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), value: unknown = JSON.parse(text);
    requireWallet(value && typeof value === "object" && !Array.isArray(value), "GENERAL_BROADCAST_INVALID", "The broadcast record is invalid.");
    const status = (value as { status?: unknown }).status;
    requireWallet(status === "BROADCAST_POSSIBLE" || status === "SUBMITTED" || status === "UNKNOWN",
      "GENERAL_BROADCAST_INVALID", "The broadcast status is invalid.");
    const expected = generalBroadcastRecord(preview, approvedDigest, riskId, transactionHash, status);
    requireWallet(canonical(expected) === text, "GENERAL_BROADCAST_INVALID", "The broadcast record does not match.");
    return expected;
  } catch { throw new WalletError("GENERAL_BROADCAST_INVALID", "The broadcast record is invalid."); }
  finally { bytes.fill(0); }
}
