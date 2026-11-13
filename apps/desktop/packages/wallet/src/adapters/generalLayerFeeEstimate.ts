import { performance } from "node:perf_hooks";
import { Interface, Transaction } from "ethers";
import type { GeneralBalanceRpc } from "../app/generalBalances.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { assertGeneralTransferPreview, type GeneralTransferPreview } from "./generalTransferIntent.js";
import { assertGeneralBoundedManualFee, assertGeneralSigningNetwork } from "../domain/generalSigningPolicy.js";

const OP_STACK = new Set(["eip155:8453", "eip155:10", "eip155:11155420"]);
const ARBITRUM = new Set(["eip155:42161", "eip155:421614"]);
const STANDARD = new Set(["eip155:1", "eip155:11155111", "eip155:56", "eip155:97",
  "eip155:137", "eip155:80002", "eip155:43114", "eip155:43113"]);
const GAS_ORACLE = "0x420000000000000000000000000000000000000f";
const ORACLE = new Interface([
  "function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)",
  "function getOperatorFee(uint256 gasUsed) view returns (uint256)",
]);
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const MAX_UINT = (1n << 256n) - 1n;

export interface GeneralLayerFeeEstimate {
  networkId: string;
  blockNumber: string;
  blockHash: string;
  l1FeeAtomic: string;
  operatorFeeAtomic: string;
  totalAtomic: string;
  /** The oracle's statistical estimate at this block is not a protocol-enforced future cap. */
  certainty: "estimate_at_block_not_a_cap";
}

export interface GeneralArbitrumGasEstimate {
  networkId: string;
  blockNumber: string;
  blockHash: string;
  gasUnits: string;
  feeAtPreviewGasPriceAtomic: string;
  /** The gas estimate already contains the current L1 component and is not a future fee cap. */
  certainty: "estimate_includes_l1_not_a_cap";
}
export interface GeneralStandardGasEstimate {
  networkId: string;
  blockNumber: string;
  blockHash: string;
  gasUnits: string;
  feeAtPreviewGasPriceAtomic: string;
  /** An estimate, not an authorization, final fee, or future fee cap. */
  certainty: "estimate_at_block_not_a_cap";
}

function unavailable(): never { throw new WalletError("GENERAL_FEE_UNAVAILABLE", "The network fee estimate is unavailable."); }
function block(input: unknown): { number: string; hash: string } {
  requireWallet(input && typeof input === "object" && !Array.isArray(input), "GENERAL_FEE_UNAVAILABLE", "Invalid network block.");
  const value = input as Record<string, unknown>;
  requireWallet(typeof value.number === "string" && QUANTITY.test(value.number) && typeof value.hash === "string" && HASH.test(value.hash),
    "GENERAL_FEE_UNAVAILABLE", "Invalid network block.");
  return { number: value.number.toLowerCase(), hash: value.hash.toLowerCase() };
}

async function call(rpc: GeneralBalanceRpc, method: string, params: readonly unknown[], parent: AbortSignal): Promise<unknown> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(8000)]);
  if (signal.aborted) return unavailable();
  let cancel = () => {};
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => reject(new WalletError("GENERAL_FEE_UNAVAILABLE", "The network fee estimate is unavailable."));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try { return await Promise.race([rpc.call(method, params, signal), stopped]); }
  finally { signal.removeEventListener("abort", cancel); }
}

/** Read-only OP-stack fee estimate; never supplies a signing permit or an enforceable fee cap. */
export async function estimateGeneralOpLayerFee(input: {
  preview: GeneralTransferPreview;
  approvedDigest: string;
  rpc: GeneralBalanceRpc;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<GeneralLayerFeeEstimate> {
  assertGeneralTransferPreview(input.preview, input.approvedDigest, (input.now ?? (() => Math.floor(performance.now())))());
  const network = generalNetwork(input.preview.networkId);
  requireWallet(OP_STACK.has(network.id), "GENERAL_FEE_UNAVAILABLE", "The network does not use this fee estimate.");
  const deadline = AbortSignal.timeout(20000), signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  try {
    const chain = await call(input.rpc, "eth_chainId", [], signal);
    requireWallet(typeof chain === "string" && QUANTITY.test(chain) && BigInt(chain) === BigInt(network.chainId),
      "GENERAL_FEE_UNAVAILABLE", "The fee RPC network is invalid.");
    for (let attempt = 0; attempt < 2; attempt++) {
      const initial = block(await call(input.rpc, "eth_getBlockByNumber", ["latest", false], signal));
      const code = await call(input.rpc, "eth_getCode", [GAS_ORACLE, initial.number], signal);
      requireWallet(typeof code === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(code) && code.length <= 49154,
        "GENERAL_FEE_UNAVAILABLE", "The fee oracle is unavailable.");
      const unsignedBytes = (input.preview.unsignedTransaction.length - 2) / 2;
      const requests = [ORACLE.encodeFunctionData("getL1FeeUpperBound", [unsignedBytes]),
        ORACLE.encodeFunctionData("getOperatorFee", [BigInt(input.preview.fee.gasLimitAtomic)])];
      const values = await Promise.all(requests.map((data) => call(input.rpc, "eth_call", [{ to: GAS_ORACLE, data }, initial.number], signal)));
      requireWallet(values.every((value) => typeof value === "string" && WORD.test(value)),
        "GENERAL_FEE_UNAVAILABLE", "The fee oracle returned invalid data.");
      const l1 = BigInt(values[0] as string), operator = BigInt(values[1] as string);
      requireWallet(l1 + operator <= MAX_UINT, "GENERAL_FEE_UNAVAILABLE", "The network fee estimate is invalid.");
      const final = block(await call(input.rpc, "eth_getBlockByNumber", [initial.number, false], signal));
      if (initial.number === final.number && initial.hash === final.hash) {
        const finalChain = await call(input.rpc, "eth_chainId", [], signal);
        requireWallet(typeof finalChain === "string" && QUANTITY.test(finalChain) && BigInt(finalChain) === BigInt(network.chainId) && !signal.aborted,
          "GENERAL_FEE_UNAVAILABLE", "The fee RPC network changed.");
        assertGeneralTransferPreview(input.preview, input.approvedDigest, (input.now ?? (() => Math.floor(performance.now())))());
        return { networkId: network.id, blockNumber: BigInt(initial.number).toString(), blockHash: initial.hash,
          l1FeeAtomic: l1.toString(), operatorFeeAtomic: operator.toString(), totalAtomic: (l1 + operator).toString(),
          certainty: "estimate_at_block_not_a_cap" };
      }
    }
    return unavailable();
  } catch (error) {
    if (error instanceof WalletError && ["LEGACY_NETWORK_RESERVED", "TRANSFER_APPROVAL_EXPIRED"].includes(error.code)) throw error;
    return unavailable();
  }
}

/** Arbitrum's eth_estimateGas already includes L1 gas; do not add a second L1 estimate. */
export async function estimateGeneralArbitrumGas(input: {
  preview: GeneralTransferPreview;
  approvedDigest: string;
  rpc: GeneralBalanceRpc;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<GeneralArbitrumGasEstimate> {
  return await estimateGas(input, ARBITRUM, "estimate_includes_l1_not_a_cap");
}

/** Fixed-block simulation for the configured non-rollup networks, without signing authority. */
export async function estimateGeneralStandardGas(input: {
  preview: GeneralTransferPreview;
  approvedDigest: string;
  rpc: GeneralBalanceRpc;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<GeneralStandardGasEstimate> {
  return await estimateGas(input, STANDARD, "estimate_at_block_not_a_cap");
}

async function estimateGas<T extends GeneralArbitrumGasEstimate["certainty"] | GeneralStandardGasEstimate["certainty"]>(input: {
  preview: GeneralTransferPreview; approvedDigest: string; rpc: GeneralBalanceRpc; signal?: AbortSignal; now?: () => number;
}, networks: ReadonlySet<string>, certainty: T): Promise<{
  networkId: string; blockNumber: string; blockHash: string; gasUnits: string; feeAtPreviewGasPriceAtomic: string; certainty: T;
}> {
  const verify = () => assertGeneralTransferPreview(input.preview, input.approvedDigest, (input.now ?? (() => Math.floor(performance.now())))());
  verify();
  return estimateCandidateGas({ ...input, networkId: input.preview.networkId, accountAddress: input.preview.accountAddress,
    assetKind: input.preview.asset.kind, unsignedTransaction: input.preview.unsignedTransaction, maximumGasAtomic: input.preview.fee.gasLimitAtomic, verify }, networks, certainty);
}

/** Read-only host bootstrap. This produces no preview, simulation ticket, approval or signing capability. */
export async function estimateGeneralDraftGas(input: {
  networkId: string; accountAddress: string; assetKind: "native" | "erc20"; unsignedTransaction: string;
  rpc: GeneralBalanceRpc; signal?: AbortSignal;
}): Promise<GeneralArbitrumGasEstimate | GeneralStandardGasEstimate> {
  const owned = { ...input }, network = generalNetwork(owned.networkId);
  assertGeneralSigningNetwork(network.id, BigInt(network.chainId)); assertGeneralBoundedManualFee(network.id);
  const verify = () => {
    const tx = Transaction.from(owned.unsignedTransaction);
    requireWallet(/^0x[0-9a-f]{40}$/.test(owned.accountAddress) && !/^0x0{40}$/.test(owned.accountAddress) &&
      (owned.assetKind === "native" || owned.assetKind === "erc20") && tx.chainId === BigInt(network.chainId) &&
      tx.signature === null && (tx.type === 0 || tx.type === 2) && tx.gasLimit === 0n && tx.to,
    "GENERAL_FEE_UNAVAILABLE", "The draft gas candidate is invalid.");
  };
  verify();
  return ARBITRUM.has(network.id) ? estimateCandidateGas({ ...owned, verify }, ARBITRUM, "estimate_includes_l1_not_a_cap") :
    estimateCandidateGas({ ...owned, verify }, STANDARD, "estimate_at_block_not_a_cap");
}

async function estimateCandidateGas<T extends GeneralArbitrumGasEstimate["certainty"] | GeneralStandardGasEstimate["certainty"]>(input: {
  networkId: string; accountAddress: string; assetKind: "native" | "erc20"; unsignedTransaction: string; maximumGasAtomic?: string;
  rpc: GeneralBalanceRpc; signal?: AbortSignal; verify(): void;
}, networks: ReadonlySet<string>, certainty: T): Promise<{
  networkId: string; blockNumber: string; blockHash: string; gasUnits: string; feeAtPreviewGasPriceAtomic: string; certainty: T;
}> {
  input.verify();
  const network = generalNetwork(input.networkId);
  requireWallet(networks.has(network.id), "GENERAL_FEE_UNAVAILABLE", "The network does not use this gas estimate.");
  const deadline = AbortSignal.timeout(20000), signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  try {
    const chain = await call(input.rpc, "eth_chainId", [], signal);
    requireWallet(typeof chain === "string" && QUANTITY.test(chain) && BigInt(chain) === BigInt(network.chainId),
      "GENERAL_FEE_UNAVAILABLE", "The fee RPC network is invalid.");
    const tx = Transaction.from(input.unsignedTransaction);
    requireWallet(tx.to && tx.chainId === BigInt(network.chainId), "GENERAL_FEE_UNAVAILABLE", "The transaction identity is invalid.");
    const hex = (value: bigint) => `0x${value.toString(16)}`;
    const request = { from: input.accountAddress, to: tx.to, value: hex(tx.value), data: tx.data, nonce: hex(BigInt(tx.nonce)),
      ...(tx.type === 0 ? { gasPrice: hex(tx.gasPrice!) } : { maxFeePerGas: hex(tx.maxFeePerGas!), maxPriorityFeePerGas: hex(tx.maxPriorityFeePerGas!) }) };
    for (let attempt = 0; attempt < 2; attempt++) {
      const initial = block(await call(input.rpc, "eth_getBlockByNumber", ["latest", false], signal));
      if (input.assetKind === "erc20") {
        const code = await call(input.rpc, "eth_getCode", [tx.to.toLowerCase(), initial.number], signal);
        requireWallet(typeof code === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(code) && code.length <= 49154,
          "GENERAL_FEE_UNAVAILABLE", "The token contract is unavailable.");
        const response = await call(input.rpc, "eth_call", [request, initial.number], signal);
        requireWallet(typeof response === "string" && WORD.test(response) && BigInt(response) === 1n,
          "GENERAL_FEE_UNAVAILABLE", "The token transfer simulation is not a standard success.");
      }
      const raw = await call(input.rpc, "eth_estimateGas", [request, initial.number], signal);
      requireWallet(typeof raw === "string" && QUANTITY.test(raw) && BigInt(raw) > 0n,
        "GENERAL_FEE_UNAVAILABLE", "The gas estimate is invalid.");
      const gas = BigInt(raw), price = tx.type === 0 ? tx.gasPrice! : tx.maxFeePerGas!;
      requireWallet((input.maximumGasAtomic === undefined || gas <= BigInt(input.maximumGasAtomic)) && price > 0n && gas * price <= MAX_UINT,
        "GENERAL_FEE_UNAVAILABLE", "The frozen gas limit does not cover the estimate.");
      const final = block(await call(input.rpc, "eth_getBlockByNumber", [initial.number, false], signal));
      if (initial.number === final.number && initial.hash === final.hash) {
        const finalChain = await call(input.rpc, "eth_chainId", [], signal);
        requireWallet(typeof finalChain === "string" && QUANTITY.test(finalChain) && BigInt(finalChain) === BigInt(network.chainId) && !signal.aborted,
          "GENERAL_FEE_UNAVAILABLE", "The fee RPC network changed.");
        input.verify();
        return { networkId: network.id, blockNumber: BigInt(initial.number).toString(), blockHash: initial.hash,
          gasUnits: gas.toString(), feeAtPreviewGasPriceAtomic: (gas * price).toString(), certainty };
      }
    }
    return unavailable();
  } catch (error) {
    if (error instanceof WalletError && ["LEGACY_NETWORK_RESERVED", "TRANSFER_APPROVAL_EXPIRED"].includes(error.code)) throw error;
    return unavailable();
  }
}
