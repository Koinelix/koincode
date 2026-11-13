import { timingSafeEqual } from "node:crypto";
import { Transaction, keccak256 } from "ethers";
import type { ProtectedStore } from "../app/ports.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { assertGeneralSigningNetwork } from "../domain/generalSigningPolicy.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical, digest } from "./canonical.js";
import type { GeneralTransferPreview } from "./generalTransferIntent.js";
import type { GeneralSigningRisk } from "../app/generalSigningTypes.js";
import { generalBroadcastRecord, parseGeneralBroadcastRecord, type GeneralBroadcastStatus } from "./generalBroadcastRecord.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const MAX_SIGNED = 8192;
// All instances sharing a protected store serialize access. The owner must also
// hold the wallet's exclusive cross-process writer lease before using this store.
const queues = new WeakMap<ProtectedStore, Promise<void>>();
const journalProofs = new WeakMap<object, { protection: ProtectedStore; preview: GeneralTransferPreview; riskId: string; transactionHash: string;
  verify: () => Promise<{ transactionHash: string }> }>();
type Stored = { format: "koincode-general-signed-transaction"; version: 1; riskId: string; ownerId: string;
  transferId: string; intentDigest: string; networkId: string; accountAddress: string; transactionHash: string; signedTransaction: string };

function invalid(): never { throw new WalletError("GENERAL_SIGNED_MATERIAL_INVALID", "The protected signed transaction is unavailable or invalid."); }

/** Performs no network action and does not consider the approval lifetime a transaction expiry. */
export function inspectGeneralSignedMaterial(preview: GeneralTransferPreview, approvedDigest: string, riskId: string, raw: string): Stored {
  try {
    requireWallet(UUID.test(riskId) && preview && typeof raw === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(raw) && raw.length <= MAX_SIGNED,
      "GENERAL_SIGNED_MATERIAL_INVALID", "Invalid signed transaction.");
    const { digest: expected, ...fields } = preview;
    requireWallet(typeof expected === "string" && /^[0-9a-f]{64}$/.test(expected) && expected === approvedDigest && digest(fields) === expected,
      "GENERAL_SIGNED_MATERIAL_INVALID", "The frozen transaction identity is invalid.");
    const network = generalNetwork(preview.networkId);
    assertGeneralSigningNetwork(network.id, BigInt(preview.chainId));
    const parsed = Transaction.from(raw), transactionHash = keccak256(raw).toLowerCase();
    requireWallet(parsed.signature !== null && parsed.from?.toLowerCase() === preview.accountAddress &&
      parsed.chainId === BigInt(network.chainId) && parsed.unsignedSerialized === preview.unsignedTransaction &&
      parsed.hash?.toLowerCase() === transactionHash && HASH.test(transactionHash),
    "GENERAL_SIGNED_MATERIAL_INVALID", "The signed transaction does not match its frozen intent.");
    return { format: "koincode-general-signed-transaction", version: 1, riskId, ownerId: preview.ownerId,
      transferId: preview.transferId, intentDigest: expected, networkId: preview.networkId, accountAddress: preview.accountAddress,
      transactionHash, signedTransaction: raw.toLowerCase() };
  } catch (error) {
    if (error instanceof WalletError && error.code === "LEGACY_NETWORK_RESERVED") throw error;
    return invalid();
  }
}

/** Protected material never crosses the renderer, Skill, log, or ordinary backup boundaries. */
export class GeneralSignedMaterialStore {
  constructor(private readonly protection: ProtectedStore) {}
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.protection) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    queues.set(this.protection, current);
    await previous;
    try { return await action(); }
    finally {
      if (queues.get(this.protection) === current) queues.delete(this.protection);
      release();
    }
  }
  async putOnce(preview: GeneralTransferPreview, approvedDigest: string, riskId: string, signedTransaction: string): Promise<{ transactionHash: string }> {
    return this.exclusive(() => this.putOnceLocked(preview, approvedDigest, riskId, signedTransaction));
  }
  /** A journal proof exists only after the exact signed bytes have been saved and read back. */
  async putForJournal(preview: GeneralTransferPreview, approvedDigest: string, riskId: string, signedTransaction: string): Promise<{
    transactionHash: string; proof: object;
  }> {
    const frozen = structuredClone(preview), { transactionHash } = await this.putOnce(frozen, approvedDigest, riskId, signedTransaction);
    return this.journalProof(frozen, approvedDigest, riskId, transactionHash);
  }
  /** Restore journal evidence from the original protected transaction, without returning its bytes. */
  async recoverForJournal(preview: GeneralTransferPreview, approvedDigest: string, riskId: string): Promise<{ transactionHash: string; proof: object }> {
    const frozen = structuredClone(preview), { transactionHash } = await this.readExact(frozen, approvedDigest, riskId);
    return this.journalProof(frozen, approvedDigest, riskId, transactionHash);
  }
  private journalProof(frozen: GeneralTransferPreview, approvedDigest: string, riskId: string, transactionHash: string): { transactionHash: string; proof: object } {
    const proof = Object.freeze({});
    journalProofs.set(proof, { protection: this.protection, preview: frozen, riskId, transactionHash,
      verify: () => this.readExact(frozen, approvedDigest, riskId) });
    return { transactionHash, proof };
  }
  private async putOnceLocked(preview: GeneralTransferPreview, approvedDigest: string, riskId: string, signedTransaction: string): Promise<{ transactionHash: string }> {
    const record = inspectGeneralSignedMaterial(preview, approvedDigest, riskId, signedTransaction);
    const reference = `general-signed:${riskId}`;
    const bytes = Buffer.from(canonical(record));
    try {
      requireWallet(bytes.byteLength <= 16384, "GENERAL_SIGNED_MATERIAL_INVALID", "The signed transaction is too large.");
      const existing = await this.protection.get(reference);
      if (existing) {
        try { requireWallet(existing.byteLength === bytes.byteLength && timingSafeEqual(existing, bytes),
          "GENERAL_SIGNED_MATERIAL_INVALID", "A different signed transaction is already protected."); }
        finally { existing.fill(0); }
      } else await this.protection.put(reference, bytes);
      const readback = await this.protection.get(reference);
      try { requireWallet(readback && readback.byteLength === bytes.byteLength && timingSafeEqual(readback, bytes),
        "GENERAL_SIGNED_MATERIAL_INVALID", "The signed transaction could not be durably verified."); }
      finally { readback?.fill(0); }
      return { transactionHash: record.transactionHash };
    } catch { return invalid(); }
    finally { bytes.fill(0); }
  }

  /** Only an independently authorized resend may consume these exact original bytes. */
  async readExact(preview: GeneralTransferPreview, approvedDigest: string, riskId: string): Promise<{ signedTransaction: string; transactionHash: string }> {
    return this.exclusive(() => this.readExactLocked(preview, approvedDigest, riskId));
  }
  /** Durable intent is established before any outbound send. Existing attempts are never replaced. */
  async beginBroadcast(preview: GeneralTransferPreview, approvedDigest: string, riskId: string): Promise<{ signedTransaction: string; transactionHash: string }> {
    return this.exclusive(async () => {
      const signed = await this.readExactLocked(preview, approvedDigest, riskId), reference = `general-broadcast:${riskId}`;
      const old = await this.protection.get(reference);
      if (old) { old.fill(0); throw new WalletError("GENERAL_BROADCAST_ALREADY_ATTEMPTED", "The original broadcast requires reconciliation."); }
      const record = generalBroadcastRecord(preview, approvedDigest, riskId, signed.transactionHash, "BROADCAST_POSSIBLE");
      await this.writeBroadcast(reference, record);
      return signed;
    });
  }
  async finishBroadcast(preview: GeneralTransferPreview, approvedDigest: string, riskId: string, transactionHash: string,
    status: "SUBMITTED" | "UNKNOWN"): Promise<void> {
    await this.exclusive(async () => {
      requireWallet(status === "SUBMITTED" || status === "UNKNOWN", "GENERAL_BROADCAST_INVALID", "The broadcast outcome is invalid.");
      const reference = `general-broadcast:${riskId}`, bytes = await this.protection.get(reference);
      requireWallet(bytes, "GENERAL_BROADCAST_INVALID", "The broadcast record is unavailable.");
      const previous = parseGeneralBroadcastRecord(bytes, preview, approvedDigest, riskId, transactionHash);
      if (previous.status === status) return;
      requireWallet(previous.status === "BROADCAST_POSSIBLE", "GENERAL_BROADCAST_INVALID", "The broadcast result cannot be replaced.");
      await this.writeBroadcast(reference, { ...previous, status });
    });
  }
  async readBroadcast(preview: GeneralTransferPreview, approvedDigest: string, riskId: string, transactionHash: string): Promise<GeneralBroadcastStatus | null> {
    return this.exclusive(async () => {
      generalBroadcastRecord(preview, approvedDigest, riskId, transactionHash, "BROADCAST_POSSIBLE");
      const bytes = await this.protection.get(`general-broadcast:${riskId}`);
      return bytes ? parseGeneralBroadcastRecord(bytes, preview, approvedDigest, riskId, transactionHash).status : null;
    });
  }
  private async writeBroadcast(reference: string, record: ReturnType<typeof generalBroadcastRecord>): Promise<void> {
    const bytes = Buffer.from(canonical(record));
    try {
      await this.protection.put(reference, bytes);
      const checked = await this.protection.get(reference);
      try { requireWallet(checked && checked.byteLength === bytes.byteLength && timingSafeEqual(checked, bytes),
        "GENERAL_BROADCAST_INVALID", "The broadcast record could not be verified."); }
      finally { checked?.fill(0); }
    } catch { throw new WalletError("GENERAL_BROADCAST_INVALID", "The broadcast record could not be protected."); }
    finally { bytes.fill(0); }
  }
  private async readExactLocked(preview: GeneralTransferPreview, approvedDigest: string, riskId: string): Promise<{ signedTransaction: string; transactionHash: string }> {
    if (!UUID.test(riskId)) return invalid();
    const bytes = await this.protection.get(`general-signed:${riskId}`);
    if (!bytes) return invalid();
    try {
      requireWallet(bytes.byteLength <= 16384, "GENERAL_SIGNED_MATERIAL_INVALID", "The protected transaction is too large.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), parsed: unknown = JSON.parse(text);
      requireWallet(parsed && typeof parsed === "object" && !Array.isArray(parsed) && canonical(parsed) === text,
        "GENERAL_SIGNED_MATERIAL_INVALID", "The protected transaction is invalid.");
      const value = parsed as Record<string, unknown>;
      requireWallet(typeof value.signedTransaction === "string", "GENERAL_SIGNED_MATERIAL_INVALID", "The signed transaction is invalid.");
      const verified = inspectGeneralSignedMaterial(preview, approvedDigest, riskId, value.signedTransaction);
      requireWallet(canonical(verified) === text, "GENERAL_SIGNED_MATERIAL_INVALID", "The protected transaction binding is invalid.");
      return { signedTransaction: verified.signedTransaction, transactionHash: verified.transactionHash };
    } catch { return invalid(); }
    finally { bytes.fill(0); }
  }
}

/** Journal admission consumes the proof and rereads protected bytes; it never returns those bytes. */
export async function consumeGeneralSignedMaterialProof(value: object, protection: ProtectedStore, ownerId: string, risk: GeneralSigningRisk, transactionHash: string): Promise<void> {
  const item = value && typeof value === "object" ? journalProofs.get(value) : undefined;
  if (value && typeof value === "object") journalProofs.delete(value);
  const preview = item?.preview, asset = preview?.asset.kind === "native" ? "native" : `erc20:${preview?.asset.address}`;
  requireWallet(item && item.protection === protection && preview && preview.ownerId === ownerId && item.riskId === risk.riskId && item.transactionHash === transactionHash &&
    preview.transferId === risk.transferId && preview.digest === risk.intentDigest && preview.accountAddress === risk.accountAddress &&
    preview.networkId === risk.networkId && preview.nonce === risk.nonce && asset === risk.asset &&
    preview.amountAtomic === risk.amountAtomic && preview.maxFeeExposureAtomic === risk.maxGasAtomic &&
    preview.expiresAt === risk.approvalExpiresAt, "GENERAL_SIGNED_MATERIAL_INVALID", "The signed material proof does not match the risk.");
  const verified = await item.verify();
  requireWallet(verified.transactionHash === transactionHash, "GENERAL_SIGNED_MATERIAL_INVALID", "The signed material has changed.");
}
