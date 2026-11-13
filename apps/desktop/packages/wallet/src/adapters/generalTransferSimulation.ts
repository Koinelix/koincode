import { performance } from "node:perf_hooks";
import type { GeneralBalanceRpc } from "../app/generalBalances.js";
import type { GeneralSigningRisk } from "../app/generalSigningTypes.js";
import { requireWallet } from "../domain/errors.js";
import { assertGeneralBoundedManualFee } from "../domain/generalSigningPolicy.js";
import { estimateGeneralArbitrumGas, estimateGeneralStandardGas } from "./generalLayerFeeEstimate.js";
import { generalRpcEndpoint } from "./generalRpcEndpoints.js";
import { GeneralRpcTransport } from "./generalRpcTransport.js";
import { assertGeneralTransferPreview, type GeneralTransferPreview } from "./generalTransferIntent.js";
import { bindGeneralFeeQuote, type GeneralFeeQuote } from "./generalFeeQuote.js";

export type GeneralTransferGasObservation = Readonly<{
  networkId: string; blockNumber: string; blockHash: string; gasUnits: string; feeAtPreviewGasPriceAtomic: string;
  certainty: "estimate_includes_l1_not_a_cap" | "estimate_at_block_not_a_cap"; observedAt: number; expiresAt: number;
}>;
const evidence = new WeakMap<object, { preview: GeneralTransferPreview; quote: GeneralFeeQuote;
  observation: GeneralTransferGasObservation; started: number; isLive: () => boolean }>();
const arbitrum = new Set(["eip155:42161", "eip155:421614"]);
let activeReads = 0;

/** Isolated simulation evidence, never an authorization or a broadcast. */
export class GeneralTransferSimulationReader {
  private readonly shutdown = new AbortController();
  private active = false;
  constructor(private readonly networkId: string,
    private readonly rpc: GeneralBalanceRpc = new GeneralRpcTransport(generalRpcEndpoint(networkId), undefined, "estimate"),
    private readonly now: () => number = () => Math.floor(performance.now())) {}

  async read(preview: GeneralTransferPreview, approvedDigest: string, quote: GeneralFeeQuote, parent?: AbortSignal): Promise<object> {
    const started = this.now();
    assertGeneralTransferPreview(preview, approvedDigest, started);
    const feeEvidence = bindGeneralFeeQuote(quote, preview, started);
    assertGeneralBoundedManualFee(preview.networkId);
    requireWallet(preview.networkId === this.networkId && Number.isSafeInteger(started) && started >= 0 &&
      started <= Number.MAX_SAFE_INTEGER - 20000 && !this.active && activeReads < 2 && !this.shutdown.signal.aborted,
    "SIGNING_CONTINUITY_UNKNOWN", "Transfer simulation is unavailable.");
    const frozen = structuredClone(preview), pending = new Set<Promise<unknown>>();
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(20000), ...(parent ? [parent] : [])]);
    const rpc: GeneralBalanceRpc = { call: (method, params, innerSignal) => {
      const work = Promise.resolve().then(() => this.rpc.call(method, params, innerSignal));
      pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work));
      return work;
    } };
    this.active = true; activeReads++;
    try {
      const input = { preview: frozen, approvedDigest, rpc, signal, now: this.now };
      const estimate = arbitrum.has(frozen.networkId) ? await estimateGeneralArbitrumGas(input) : await estimateGeneralStandardGas(input);
      const current = this.now();
      assertGeneralTransferPreview(frozen, approvedDigest, current);
      requireWallet(!signal.aborted && feeEvidence.isLive() && Number.isSafeInteger(current) && current >= started && current - started < 20000,
        "SIGNING_CONTINUITY_UNKNOWN", "Transfer simulation is stale.");
      const ticket = Object.freeze({});
      const observation: GeneralTransferGasObservation = Object.freeze({ ...estimate, observedAt: started,
        expiresAt: Math.min(started + 20000, feeEvidence.expiresAt) });
      evidence.set(ticket, { preview: frozen, quote, observation, started, isLive: () => !signal.aborted && feeEvidence.isLive() });
      return ticket;
    } finally {
      const release = () => { this.active = false; activeReads--; };
      if (pending.size) void Promise.allSettled(pending).then(release); else release();
    }
  }

  close(): void { this.shutdown.abort(); }
}

/** Display only the observation produced for the exact original frozen transfer. */
export function describeGeneralTransferSimulation(value: object, preview: GeneralTransferPreview, quote: GeneralFeeQuote, now: number): GeneralTransferGasObservation {
  const item = value && typeof value === "object" ? evidence.get(value) : undefined;
  requireWallet(item && item.isLive() && Number.isSafeInteger(now) && now >= item.started && now < item.observation.expiresAt &&
    item.quote === quote && item.preview.ownerId === preview.ownerId && item.preview.transferId === preview.transferId && item.preview.digest === preview.digest,
  "SIGNING_CONTINUITY_UNKNOWN", "The transfer simulation observation is unavailable.");
  assertGeneralTransferPreview(preview, item.preview.digest, now);
  return Object.freeze({ ...item.observation });
}

export function consumeGeneralTransferSimulation(value: object, ownerId: string, risk: GeneralSigningRisk, now: number, quote?: GeneralFeeQuote): {
  startedAt: number; expiresAt: number; isLive: () => boolean; observation: GeneralTransferGasObservation; feeObservation: GeneralFeeQuote;
} {
  const item = value && typeof value === "object" ? evidence.get(value) : undefined;
  if (value && typeof value === "object") evidence.delete(value);
  requireWallet(item && (quote === undefined || item.quote === quote) && item.isLive() && Number.isSafeInteger(now) && now >= item.started && now < item.observation.expiresAt,
    "SIGNING_CONTINUITY_UNKNOWN", "Transfer simulation evidence is unavailable.");
  const preview = item.preview, asset = preview.asset.kind === "native" ? "native" : `erc20:${preview.asset.address}`;
  requireWallet(preview.ownerId === ownerId && preview.transferId === risk.transferId && preview.digest === risk.intentDigest &&
    preview.accountAddress === risk.accountAddress && preview.networkId === risk.networkId && preview.nonce === risk.nonce &&
    asset === risk.asset && preview.amountAtomic === risk.amountAtomic && preview.maxFeeExposureAtomic === risk.maxGasAtomic &&
    preview.expiresAt === risk.approvalExpiresAt, "SIGNING_CONTINUITY_UNKNOWN", "Simulation evidence does not match the frozen intent.");
  assertGeneralTransferPreview(preview, risk.intentDigest, now);
  return { startedAt: item.started, expiresAt: item.observation.expiresAt, isLive: item.isLive,
    observation: item.observation, feeObservation: item.quote };
}
