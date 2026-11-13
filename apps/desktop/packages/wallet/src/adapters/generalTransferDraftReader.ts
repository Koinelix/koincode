import { performance } from "node:perf_hooks";
import { Interface, Transaction } from "ethers";
import { z } from "zod";
import { readGeneralBalances, type GeneralBalanceRpc } from "../app/generalBalances.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { generalTokens } from "../domain/generalTokens.js";
import { assertGeneralBoundedManualFee, assertGeneralSigningNetwork } from "../domain/generalSigningPolicy.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical } from "./canonical.js";
import type { GeneralFeeQuote } from "./generalFeeQuote.js";
import { estimateGeneralDraftGas } from "./generalLayerFeeEstimate.js";
import { GENERAL_RPC_CONFIG_VERSION, generalRpcEndpoint } from "./generalRpcEndpoints.js";
import { GeneralRpcTransport } from "./generalRpcTransport.js";
import type { GeneralSigningJournal } from "./generalSigningJournal.js";
import { normalizeGeneralTransferAddress, parseGeneralTransferAmount, prepareGeneralTransfer } from "./generalTransferIntent.js";

export type GeneralTransferDraft = Omit<Parameters<typeof prepareGeneralTransfer>[0], "ownerId" | "accountAddress" | "nonce" | "now">;
const schema = z.strictObject({ accountId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  networkId: z.string().max(32), assetId: z.string().regex(/^(?:native|erc20:0x[0-9a-f]{40})$/), recipient: z.string().max(64), amount: z.string().max(256) });
export type GeneralTransferInput = z.infer<typeof schema>;
export function parseGeneralTransferInput(input: unknown): GeneralTransferInput {
  const parsed = schema.safeParse(input);
  requireWallet(parsed.success, "INVALID_REQUEST", "Exactly five manual transfer input fields are required.");
  return parsed.data!;
}
type Asset = GeneralTransferDraft["asset"];
type Selection = { input: GeneralTransferInput; asset: Asset; amountAtomic: string };
type Options = { rpc?: GeneralBalanceRpc; now?: () => number; configVersion?: number;
  /** Only a fixed trusted host registry may resolve already verified custom-token precision. */
  resolveToken?(networkId: string, address: string): { address: string; decimals: number } | null };
const transfer = new Interface(["function transfer(address to, uint256 value) returns (bool)"]);
let activeReaders = 0;
const canceled = () => new WalletError("GENERAL_OPERATION_CANCELED", "The original manual input operation ended.");

/** Read-only bootstrap under the coordinator's original nonce reservation, never a second transfer owner. */
export class GeneralTransferDraftReader {
  private readonly abort = new AbortController();
  private readonly rpc: GeneralBalanceRpc;
  private readonly now: () => number;
  private readonly configVersion: number;
  private readonly resolveToken: NonNullable<Options["resolveToken"]>;
  private active?: Promise<void>;
  private closing?: Promise<void>;
  constructor(private readonly networkId: string, options: Options = {}) {
    generalNetwork(networkId);
    this.rpc = options.rpc ?? new GeneralRpcTransport(generalRpcEndpoint(networkId), undefined, "estimate");
    this.now = options.now ?? (() => Math.floor(performance.now())); this.configVersion = options.configVersion ?? GENERAL_RPC_CONFIG_VERSION;
    this.resolveToken = options.resolveToken?.bind(options) ?? ((network, address) => generalTokens(network).find((token) => token.address === address) ?? null);
    requireWallet(Number.isSafeInteger(this.configVersion) && this.configVersion > 0, "INVALID_REQUEST", "The transfer configuration is invalid.");
  }
  /** No IO: reject renderer authority fields, unsupported identities and invalid precision before reserving a nonce. */
  select(input: unknown): Selection {
    const value = parseGeneralTransferInput(input), network = generalNetwork(value.networkId);
    requireWallet(value.networkId === this.networkId, "INVALID_REQUEST", "The manual input network does not match its owner.");
    assertGeneralSigningNetwork(network.id, BigInt(network.chainId)); assertGeneralBoundedManualFee(network.id);
    value.recipient = normalizeGeneralTransferAddress(value.recipient.trim());
    let asset: Asset = { kind: "native", decimals: 18 };
    if (value.assetId !== "native") {
      const address = normalizeGeneralTransferAddress(value.assetId.slice(6)), token = this.resolveToken(network.id, address);
      requireWallet(token && token.address === address && Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 255,
        "INVALID_ASSET", "A registered token with verified precision is required.");
      asset = { kind: "erc20", address, decimals: token.decimals };
    }
    return { input: value, asset, amountAtomic: parseGeneralTransferAmount(value.amount, asset.decimals) };
  }
  async read(selection: Selection, context: { accountAddress: string; nonce: number; quote: GeneralFeeQuote; journal: GeneralSigningJournal },
    parent: AbortSignal, checkOwner: () => void): Promise<GeneralTransferDraft> {
    requireWallet(!this.active && activeReaders < 2, "GENERAL_OPERATION_BUSY", "Manual input readers are busy.");
    if (this.abort.signal.aborted || parent.aborted) throw canceled();
    const selected = this.select(selection.input);
    requireWallet(canonical(selected) === canonical(selection), "INVALID_ASSET", "The original transfer asset configuration changed.");
    const accountAddress = normalizeGeneralTransferAddress(context.accountAddress), quote = structuredClone(context.quote), nonce = context.nonce;
    const started = this.now(), deadline = Math.min(started + 20000, quote.expiresAt); let last = started, invalidTime = false;
    requireWallet(quote.networkId === this.networkId && Number.isSafeInteger(started) && started >= quote.observedAt && started < deadline &&
      Number.isSafeInteger(nonce) && nonce >= 0, "GENERAL_FEE_UNAVAILABLE", "The original draft fee or nonce is unavailable.");
    const controller = new AbortController(), signal = AbortSignal.any([parent, this.abort.signal, controller.signal]);
    const pending = new Set<Promise<unknown>>();
    const current = (terminal = false) => {
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < last || now >= deadline) { invalidTime = true; controller.abort(); } last = now;
      if (invalidTime || parent.aborted || this.abort.signal.aborted || !terminal && signal.aborted || now < started) throw canceled();
      checkOwner();
    };
    const rpc: GeneralBalanceRpc = { call: async (method, params, innerSignal) => {
      current(); const bounded = AbortSignal.any([signal, innerSignal, AbortSignal.timeout(8000)]);
      const work = Promise.resolve().then(() => { current(); return this.rpc.call(method, params, bounded); }); pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work));
      let stop = () => {};
      const canceledCall = new Promise<never>((_, reject) => { stop = () => reject(canceled()); bounded.addEventListener("abort", stop, { once: true }); if (bounded.aborted) stop(); });
      try { const value = await Promise.race([work, canceledCall]); current(); return value; }
      finally { bounded.removeEventListener("abort", stop); }
    } };
    let finish!: () => void; this.active = new Promise<void>((resolve) => { finish = resolve; }); activeReaders++;
    const timer = setTimeout(() => controller.abort(), deadline - started); timer.unref();
    let result: GeneralTransferDraft | undefined, failure: unknown;
    try {
      current();
      const fee: GeneralTransferDraft["fee"] = quote.baseFeePerGasAtomic !== null && quote.priorityFeePerGasAtomic !== null ?
        { type: "eip1559", gasLimitAtomic: "0", maxFeePerGasAtomic: quote.gasPriceAtomic, maxPriorityFeePerGasAtomic: quote.priorityFeePerGasAtomic,
          maxLayerFeeAtomic: "0", policy: "standard" } :
        { type: "legacy", gasLimitAtomic: "0", gasPriceAtomic: quote.gasPriceAtomic, maxLayerFeeAtomic: "0", policy: "standard" };
      const network = generalNetwork(this.networkId), amount = BigInt(selected.amountAtomic), asset = selected.asset;
      fee.policy = ["eip155:42161", "eip155:421614"].includes(network.id) ? "arbitrum" : "standard";
      const transaction = Transaction.from({ type: fee.type === "legacy" ? 0 : 2, chainId: BigInt(network.chainId), nonce,
        to: asset.kind === "native" ? selected.input.recipient : asset.address, value: asset.kind === "native" ? amount : 0n,
        data: asset.kind === "native" ? "0x" : transfer.encodeFunctionData("transfer", [selected.input.recipient, amount]), gasLimit: 0n,
        ...(fee.type === "legacy" ? { gasPrice: BigInt(fee.gasPriceAtomic) } :
          { maxFeePerGas: BigInt(fee.maxFeePerGasAtomic), maxPriorityFeePerGas: BigInt(fee.maxPriorityFeePerGasAtomic) }) });
      const assets = asset.kind === "native" ? [{ kind: "native" as const }] : [{ kind: "native" as const },
        { kind: "erc20" as const, contractAddress: asset.address, expectedDecimals: asset.decimals }];
      const [balances, estimate] = await Promise.all([
        readGeneralBalances({ networkId: network.id, address: accountAddress, assets, rpc, signal }),
        estimateGeneralDraftGas({ networkId: network.id, accountAddress, assetKind: asset.kind, unsignedTransaction: transaction.unsignedSerialized, rpc, signal }),
      ]);
      current();
      requireWallet(balances.assets.length === assets.length && balances.assets.every((item) => item.status === "fresh" && item.amountAtomic !== null),
        "GENERAL_FUNDS_UNAVAILABLE", "Fresh balances and matching token precision are required.");
      const risk = await context.journal.riskSnapshot(accountAddress, network.id, asset.kind === "native" ? "native" : `erc20:${asset.address as `0x${string}`}`);
      current();
      result = { accountId: selected.input.accountId, networkId: network.id, asset, recipient: selected.input.recipient,
        amountAtomic: selected.amountAtomic, fee: { ...fee, gasLimitAtomic: estimate.gasUnits }, configVersion: this.configVersion,
        nativeBalanceAtomic: balances.assets[0]!.amountAtomic!, assetBalanceAtomic: balances.assets[asset.kind === "native" ? 0 : 1]!.amountAtomic!,
        assetRiskAtomic: risk.assetRiskAtomic, nativeRiskAtomic: risk.nativeRiskAtomic };
    } catch (error) { failure = error; }
    finally { controller.abort(); clearTimeout(timer); await Promise.allSettled(pending); this.active = undefined; activeReaders--; finish(); }
    if (failure) throw failure instanceof WalletError ? failure : new WalletError("GENERAL_DRAFT_UNAVAILABLE", "The original manual input could not be prepared.");
    current(true); return result!;
  }
  close(): Promise<void> {
    if (!this.closing) { this.closing = Promise.resolve().then(() => this.active); this.abort.abort(); }
    return this.closing;
  }
}
