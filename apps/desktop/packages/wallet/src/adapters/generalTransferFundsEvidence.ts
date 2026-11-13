import { performance } from "node:perf_hooks";
import type { GeneralBalanceRpc } from "../app/generalBalances.js";
import type { GeneralSigningRisk } from "../app/generalSigningTypes.js";
import { assertGeneralTransferFunds } from "../domain/generalTransferFunds.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { GeneralBalanceService } from "./generalBalanceService.js";
import { assertGeneralTransferPreview, type GeneralTransferPreview } from "./generalTransferIntent.js";

const evidence = new WeakMap<object, { preview: GeneralTransferPreview; nativeBalance: string; assetBalance: string;
  started: number; isLive: () => boolean }>();

/** Fresh, uncached balances only; this reader is independent from the Skill payment runtime. */
export class GeneralTransferFundsReader {
  private readonly service: GeneralBalanceService;
  private closed = false;
  constructor(rpc?: GeneralBalanceRpc, private readonly now: () => number = () => Math.floor(performance.now())) {
    this.service = rpc ? new GeneralBalanceService(() => rpc, now) : new GeneralBalanceService(undefined, now);
  }

  async read(preview: GeneralTransferPreview, approvedDigest: string, signal?: AbortSignal): Promise<object> {
    requireWallet(!this.closed, "SIGNING_CONTINUITY_UNKNOWN", "The transfer balance reader is unavailable.");
    const started = this.now();
    assertGeneralTransferPreview(preview, approvedDigest, started);
    const frozen = structuredClone(preview);
    const assets = frozen.asset.kind === "native" ? [{ kind: "native" as const }] : [
      { kind: "native" as const }, { kind: "erc20" as const, contractAddress: frozen.asset.address, expectedDecimals: frozen.asset.decimals }];
    const snapshot = await this.service.read({ networkId: frozen.networkId, address: frozen.accountAddress, assets, signal });
    const current = this.now();
    assertGeneralTransferPreview(frozen, approvedDigest, current);
    requireWallet(!this.closed && !signal?.aborted && Number.isSafeInteger(current) && current >= started && current - started < 20000 &&
      snapshot.networkId === frozen.networkId && snapshot.address === frozen.accountAddress &&
      snapshot.assets.length === assets.length && snapshot.assets.every((item) => item.status === "fresh" && typeof item.amountAtomic === "string"),
    "SIGNING_CONTINUITY_UNKNOWN", "Fresh transfer balances are unavailable.");
    const nativeBalance = snapshot.assets[0]!.amountAtomic!, assetBalance = snapshot.assets.at(-1)!.amountAtomic!;
    const ticket = Object.freeze({});
    evidence.set(ticket, { preview: frozen, nativeBalance, assetBalance, started, isLive: () => !this.closed && !signal?.aborted });
    return ticket;
  }

  close(): void { this.closed = true; this.service.close(); }
}

/** Called inside the journal's exclusive admission, after nonce binding and before appending risk. */
export function consumeGeneralTransferFunds(value: object, ownerId: string, risk: GeneralSigningRisk, now: number): {
  startedAt: number; expiresAt: number; isLive: () => boolean;
} {
  const item = value && typeof value === "object" ? evidence.get(value) : undefined;
  if (value && typeof value === "object") evidence.delete(value);
  requireWallet(item && item.isLive() && Number.isSafeInteger(now) && now >= item.started && now - item.started < 20000,
    "SIGNING_CONTINUITY_UNKNOWN", "Fresh transfer balance evidence is unavailable.");
  const preview = item.preview, asset = preview.asset.kind === "native" ? "native" : `erc20:${preview.asset.address}`;
  requireWallet(preview.ownerId === ownerId && preview.transferId === risk.transferId && preview.digest === risk.intentDigest &&
    preview.accountAddress === risk.accountAddress && preview.networkId === risk.networkId && preview.nonce === risk.nonce &&
    asset === risk.asset && preview.amountAtomic === risk.amountAtomic && preview.maxFeeExposureAtomic === risk.maxGasAtomic &&
    preview.expiresAt === risk.approvalExpiresAt, "SIGNING_CONTINUITY_UNKNOWN", "Transfer balance evidence does not match the frozen intent.");
  try {
    assertGeneralTransferPreview(preview, risk.intentDigest, now);
    // The journal currently permits no unresolved risk in this stream before this check.
    assertGeneralTransferFunds({ assetKind: preview.asset.kind, amountAtomic: preview.amountAtomic,
      assetBalanceAtomic: item.assetBalance, nativeBalanceAtomic: item.nativeBalance, assetRiskAtomic: "0", nativeRiskAtomic: "0",
      maxFeeAtomic: preview.maxFeeExposureAtomic });
  } catch (error) { if (error instanceof WalletError) throw error; throw new WalletError("SIGNING_CONTINUITY_UNKNOWN", "Transfer balances are unavailable."); }
  return { startedAt: item.started, expiresAt: item.started + 20000, isLive: item.isLive };
}
