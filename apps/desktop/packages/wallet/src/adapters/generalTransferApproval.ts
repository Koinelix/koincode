import { performance } from "node:perf_hooks";
import type { GeneralSigningRisk } from "../app/generalSigningTypes.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { assertGeneralTransferPreview, type GeneralTransferPreview } from "./generalTransferIntent.js";
import type { GeneralEvidenceLifetime } from "./generalSigningCapability.js";
import { bindGeneralFeeQuote, type GeneralFeeQuote } from "./generalFeeQuote.js";
import { consumeGeneralTransferSimulation, type GeneralTransferGasObservation } from "./generalTransferSimulation.js";

export type GeneralTransferConfirmation = Readonly<{
  transferId: string; ownerId: string; accountId: string; accountAddress: string; networkId: string; chainId: string;
  asset: Readonly<GeneralTransferPreview["asset"]>; recipient: string; amountAtomic: string; nonce: number;
  fee: Readonly<GeneralTransferPreview["fee"]>; maxFeeExposureAtomic: string; digest: string;
  configVersion: number; signingPolicyVersion: number; signingPolicyDigest: string; expiresAt: number;
  feeObservation: GeneralFeeQuote;
  gasObservation: GeneralTransferGasObservation;
}>;
type Host = {
  /** Both callbacks belong to the trusted desktop host, never the renderer or Skill. */
  confirm(details: GeneralTransferConfirmation, signal: AbortSignal): Promise<boolean>;
  authenticate(signal: AbortSignal, preview: Readonly<GeneralTransferPreview>): Promise<boolean>;
  isCurrent(): boolean;
};
const evidence = new WeakMap<object, { preview: GeneralTransferPreview; startedAt: number; expiresAt: number; isLive: () => boolean;
  feeObservation: GeneralFeeQuote; gasObservation: GeneralTransferGasObservation }>();

/** Owns only new manual-transfer approval; it does not modify existing payment grants or budgets. */
export class GeneralTransferApprovalOwner {
  private closed = false;
  private generation = 0;
  private active?: AbortController;
  constructor(private readonly host: Host, private readonly now: () => number = () => Math.floor(performance.now())) {}

  async approve(preview: GeneralTransferPreview, approvedDigest: string, quote: GeneralFeeQuote, simulation: object): Promise<object> {
    requireWallet(!this.closed && !this.active, "GENERAL_OPERATION_BUSY", "Manual approval is unavailable or busy.");
    const startedAt = this.now();
    assertGeneralTransferPreview(preview, approvedDigest, startedAt);
    const feeEvidence = bindGeneralFeeQuote(quote, preview, startedAt);
    const asset = preview.asset.kind === "native" ? "native" as const : `erc20:${preview.asset.address}` as const;
    const preflight = consumeGeneralTransferSimulation(simulation, preview.ownerId, { riskId: preview.transferId,
      transferId: preview.transferId, intentDigest: preview.digest, accountAddress: preview.accountAddress, networkId: preview.networkId,
      nonce: preview.nonce, asset, amountAtomic: preview.amountAtomic, maxGasAtomic: preview.maxFeeExposureAtomic,
      approvalExpiresAt: preview.expiresAt }, startedAt, quote);
    const frozen = structuredClone(preview), generation = ++this.generation, controller = new AbortController();
    Object.freeze(frozen.asset); Object.freeze(frozen.fee); Object.freeze(frozen);
    this.active = controller;
    const expiresAt = Math.min(frozen.expiresAt, feeEvidence.expiresAt, preflight.expiresAt);
    const isLive = () => {
      const current = this.now();
      if (!Number.isSafeInteger(current) || current < startedAt || current >= expiresAt) controller.abort();
      return !this.closed && this.generation === generation && !controller.signal.aborted &&
        feeEvidence.isLive() && preflight.isLive() && this.host.isCurrent() === true;
    };
    const check = () => {
      let current = false;
      try { current = isLive(); } catch { /* A missing host is not authorization. */ }
      requireWallet(current, "GENERAL_OPERATION_CANCELED", "Manual approval was canceled.");
      assertGeneralTransferPreview(frozen, approvedDigest, this.now());
    };
    const details: GeneralTransferConfirmation = Object.freeze({ transferId: frozen.transferId, ownerId: frozen.ownerId,
      accountId: frozen.accountId, accountAddress: frozen.accountAddress, networkId: frozen.networkId, chainId: frozen.chainId,
      asset: Object.freeze({ ...frozen.asset }), recipient: frozen.recipient, amountAtomic: frozen.amountAtomic, nonce: frozen.nonce,
      fee: Object.freeze({ ...frozen.fee }), maxFeeExposureAtomic: frozen.maxFeeExposureAtomic, digest: frozen.digest,
      configVersion: frozen.configVersion, signingPolicyVersion: frozen.signingPolicyVersion,
      signingPolicyDigest: frozen.signingPolicyDigest, expiresAt,
      feeObservation: Object.freeze({ ...quote }),
      gasObservation: Object.freeze({ ...preflight.observation }) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      check();
      timer = setTimeout(() => controller.abort(), Math.max(0, expiresAt - this.now()));
      requireWallet(await this.host.confirm(details, controller.signal) === true, "GENERAL_APPROVAL_DECLINED", "Manual transfer was not confirmed.");
      check();
      try { requireWallet(await this.host.authenticate(controller.signal, frozen) === true, "GENERAL_AUTH_REQUIRED", "System authentication is required."); }
      catch { throw new WalletError("GENERAL_AUTH_REQUIRED", "System authentication is required."); }
      check();
      const ticket = Object.freeze({});
      evidence.set(ticket, { preview: frozen, startedAt, expiresAt,
        isLive, feeObservation: quote, gasObservation: preflight.observation });
      return ticket;
    } finally { clearTimeout(timer); if (this.active === controller) this.active = undefined; }
  }

  invalidate(): void { this.generation++; this.active?.abort(); }
  close(): void { if (!this.closed) { this.closed = true; this.invalidate(); } }
}

/** One use only; authorization is bound to the exact manually confirmed transaction. */
export function consumeGeneralTransferApproval(value: object, ownerId: string, risk: GeneralSigningRisk, now: number): GeneralEvidenceLifetime & {
  feeObservation: GeneralFeeQuote; gasObservation: GeneralTransferGasObservation;
} {
  const item = value && typeof value === "object" ? evidence.get(value) : undefined;
  if (value && typeof value === "object") evidence.delete(value);
  let live = false;
  try { live = item?.isLive() === true; } catch { /* A missing host is not authorization. */ }
  requireWallet(item && live && Number.isSafeInteger(now) && now >= item.startedAt && now < item.expiresAt,
    "SIGNING_CONTINUITY_UNKNOWN", "Manual approval is unavailable or expired.");
  const preview = item.preview, asset = preview.asset.kind === "native" ? "native" : `erc20:${preview.asset.address}`;
  requireWallet(preview.ownerId === ownerId && preview.transferId === risk.transferId && preview.digest === risk.intentDigest &&
    preview.accountAddress === risk.accountAddress && preview.networkId === risk.networkId && preview.nonce === risk.nonce &&
    asset === risk.asset && preview.amountAtomic === risk.amountAtomic && preview.maxFeeExposureAtomic === risk.maxGasAtomic &&
    preview.expiresAt === risk.approvalExpiresAt, "SIGNING_CONTINUITY_UNKNOWN", "Manual approval does not match the frozen transfer.");
  assertGeneralTransferPreview(preview, risk.intentDigest, now);
  return { startedAt: item.startedAt, expiresAt: item.expiresAt, isLive: item.isLive,
    feeObservation: item.feeObservation, gasObservation: item.gasObservation };
}
