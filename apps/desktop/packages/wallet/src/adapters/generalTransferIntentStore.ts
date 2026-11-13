import { timingSafeEqual } from "node:crypto";
import type { ProtectedStore } from "../app/ports.js";
import type { GeneralSigningRisk } from "../app/generalSigningTypes.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical } from "./canonical.js";
import { assertFreshGeneralPreparedPreview, assertGeneralTransferPreview, type GeneralTransferPreview } from "./generalTransferIntent.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const queues = new WeakMap<ProtectedStore, Promise<void>>();
const proofs = new WeakMap<object, { protection: ProtectedStore; preview: GeneralTransferPreview; riskId: string; verify: () => Promise<GeneralTransferPreview> }>();
const fail = () => new WalletError("GENERAL_INTENT_UNAVAILABLE", "The protected transfer intent is unavailable.");

function validate(preview: GeneralTransferPreview, riskId: string): void {
  requireWallet(UUID.test(riskId) && preview && Number.isSafeInteger(preview.expiresAt) && preview.expiresAt > 0,
    "GENERAL_INTENT_UNAVAILABLE", "The transfer intent identity is invalid.");
  // Structural recovery only: this does not renew an expired approval or authorize signing.
  assertGeneralTransferPreview(preview, preview.digest, preview.expiresAt - 1);
}
function matches(preview: GeneralTransferPreview, ownerId: string, risk: GeneralSigningRisk): boolean {
  const asset = preview.asset.kind === "native" ? "native" : `erc20:${preview.asset.address}`;
  return preview.ownerId === ownerId && preview.transferId === risk.transferId && preview.digest === risk.intentDigest &&
    preview.accountAddress === risk.accountAddress && preview.networkId === risk.networkId && preview.nonce === risk.nonce &&
    asset === risk.asset && preview.amountAtomic === risk.amountAtomic && preview.maxFeeExposureAtomic === risk.maxGasAtomic &&
    preview.expiresAt === risk.approvalExpiresAt;
}

/** Structural history verification only; it does not renew approval or issue a signing capability. */
export function assertGeneralHistoricalIntent(preview: GeneralTransferPreview, ownerId: string, risk: GeneralSigningRisk): void {
  validate(preview, risk.riskId);
  requireWallet(matches(preview, ownerId, risk), "GENERAL_INTENT_UNAVAILABLE", "The transfer intent does not match the protected risk.");
}

/** Consumes a bounded historical record buffer without renewing approval or creating an intent owner. */
export function parseGeneralHistoricalIntentRecord(bytes: Uint8Array, ownerId: string, risk: GeneralSigningRisk): GeneralTransferPreview {
  try {
    requireWallet(bytes.byteLength <= 16384, "GENERAL_INTENT_UNAVAILABLE", "The transfer intent is too large.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), parsed: unknown = JSON.parse(text);
    requireWallet(parsed && typeof parsed === "object" && !Array.isArray(parsed), "GENERAL_INTENT_UNAVAILABLE", "The transfer intent is invalid.");
    const row = parsed as Record<string, unknown>, preview = row.preview as GeneralTransferPreview;
    requireWallet(row.format === "koincode-general-transfer-intent" && row.version === 1 && row.riskId === risk.riskId &&
      canonical({ format: row.format, version: row.version, riskId: row.riskId, preview }) === text,
    "GENERAL_INTENT_UNAVAILABLE", "The transfer intent is invalid.");
    assertGeneralHistoricalIntent(preview, ownerId, risk);
    return structuredClone(preview);
  } catch { throw fail(); }
  finally { bytes.fill(0); }
}

/** Independent protected intent projection; it contains neither signed bytes nor keys. */
export class GeneralTransferIntentStore {
  constructor(private readonly protection: ProtectedStore) {}
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.protection) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    queues.set(this.protection, current); await previous;
    try { return await operation(); }
    finally { if (queues.get(this.protection) === current) queues.delete(this.protection); release(); }
  }
  async saveForJournal(preview: GeneralTransferPreview, riskId: string, now: number): Promise<object> {
    assertFreshGeneralPreparedPreview(preview, now);
    const frozen = structuredClone(preview);
    validate(frozen, riskId);
    assertGeneralTransferPreview(frozen, frozen.digest, now);
    await this.exclusive(async () => {
      const record = { format: "koincode-general-transfer-intent", version: 1, riskId, preview: frozen };
      const bytes = Buffer.from(canonical(record)), reference = `general-intent:${riskId}`;
      try {
        requireWallet(bytes.byteLength <= 16384, "GENERAL_INTENT_UNAVAILABLE", "The transfer intent is too large.");
        const existing = await this.protection.get(reference);
        if (existing) {
          try { requireWallet(existing.byteLength === bytes.byteLength && timingSafeEqual(existing, bytes),
            "GENERAL_INTENT_UNAVAILABLE", "A different transfer intent already exists."); }
          finally { existing.fill(0); }
        } else await this.protection.put(reference, bytes);
        const checked = await this.protection.get(reference);
        try { requireWallet(checked && checked.byteLength === bytes.byteLength && timingSafeEqual(checked, bytes),
          "GENERAL_INTENT_UNAVAILABLE", "The transfer intent could not be verified."); }
        finally { checked?.fill(0); }
      } catch { throw fail(); }
      finally { bytes.fill(0); }
    });
    const ticket = Object.freeze({});
    proofs.set(ticket, { protection: this.protection, preview: frozen, riskId,
      verify: () => this.readForRecovery(frozen.ownerId, { riskId, transferId: frozen.transferId, intentDigest: frozen.digest,
        accountAddress: frozen.accountAddress, networkId: frozen.networkId, nonce: frozen.nonce,
        asset: frozen.asset.kind === "native" ? "native" : `erc20:${frozen.asset.address}`,
        amountAtomic: frozen.amountAtomic, maxGasAtomic: frozen.maxFeeExposureAtomic, approvalExpiresAt: frozen.expiresAt }) });
    return ticket;
  }
  async readForRecovery(ownerId: string, risk: GeneralSigningRisk): Promise<GeneralTransferPreview> {
    return this.exclusive(async () => {
      requireWallet(UUID.test(risk.riskId), "GENERAL_INTENT_UNAVAILABLE", "The transfer intent identity is invalid.");
      const bytes = await this.protection.get(`general-intent:${risk.riskId}`);
      if (!bytes) throw fail();
      return parseGeneralHistoricalIntentRecord(bytes, ownerId, risk);
    });
  }
}

export async function consumeGeneralTransferIntent(value: object, protection: ProtectedStore, ownerId: string, risk: GeneralSigningRisk): Promise<void> {
  const item = value && typeof value === "object" ? proofs.get(value) : undefined;
  if (value && typeof value === "object") proofs.delete(value);
  requireWallet(item && item.protection === protection && item.riskId === risk.riskId && matches(item.preview, ownerId, risk),
    "GENERAL_INTENT_UNAVAILABLE", "The protected transfer intent does not match the signing risk.");
  const verified = await item.verify();
  requireWallet(matches(verified, ownerId, risk), "GENERAL_INTENT_UNAVAILABLE", "The protected transfer intent has changed.");
}
