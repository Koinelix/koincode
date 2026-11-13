import type { GeneralSigningRisk } from "../app/generalSigningTypes.js";
import { requireWallet } from "../domain/errors.js";
export type GeneralPendingRisk = { risk: GeneralSigningRisk; phase: "SIGNING_POSSIBLE" | "SIGNED"; transactionHash?: string };
type RiskEvent = { risk: GeneralSigningRisk; phase: "SIGNING_POSSIBLE" | "SIGNED"; transactionHash?: string };

/** Only verified journal events may be projected; pagination is bound to one protected head. */
export function pageGeneralSigningRisks(events: RiskEvent[], active: ReadonlyMap<string, GeneralSigningRisk>,
  head: string, offset: number, limit: number, expectedHead?: string): { items: GeneralPendingRisk[]; nextOffset: number | null; head: string } {
  requireWallet(Number.isSafeInteger(offset) && offset >= 0 && offset <= 1000 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 20 &&
    (offset === 0 && expectedHead === undefined || typeof expectedHead === "string" && /^[0-9a-f]{64}$/.test(expectedHead) && expectedHead === head),
  "SIGNING_CONTINUITY_CONFLICT", "The signing risk page is invalid or changed.");
  const signed = new Map(events.filter((event) => event.phase === "SIGNED").map((event) => [event.risk.riskId, event.transactionHash!]));
  const items = [...active.values()].slice(offset, offset + limit).map((risk): GeneralPendingRisk => {
    const transactionHash = signed.get(risk.riskId);
    return { risk: structuredClone(risk), phase: transactionHash ? "SIGNED" : "SIGNING_POSSIBLE", ...(transactionHash ? { transactionHash } : {}) };
  });
  return { items, nextOffset: offset + items.length < active.size ? offset + items.length : null, head };
}

/** Only journal-validated risks may enter this calculation. */
export function sumGeneralSigningRisk(active: ReadonlyMap<string, GeneralSigningRisk>, asset: "native" | `erc20:0x${string}`): {
  assetRiskAtomic: string; nativeRiskAtomic: string; riskCount: number;
} {
  let native = 0n, token = 0n;
  for (const item of active.values()) {
    native += BigInt(item.maxGasAtomic);
    if (item.asset === "native") native += BigInt(item.amountAtomic);
    else if (item.asset === asset) token += BigInt(item.amountAtomic);
  }
  requireWallet(native < 1n << 256n && token < 1n << 256n,
    "SIGNING_CONTINUITY_CONFLICT", "The signing risk total is invalid.");
  return { assetRiskAtomic: (asset === "native" ? native : token).toString(), nativeRiskAtomic: native.toString(), riskCount: active.size };
}
