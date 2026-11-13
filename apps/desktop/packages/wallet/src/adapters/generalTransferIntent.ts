import { randomUUID } from "node:crypto";
import { getAddress, Interface, Transaction } from "ethers";
import { atomic, positiveAtomic } from "../domain/atomic.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { assertGeneralSigningNetwork, GENERAL_SIGNING_POLICY_DIGEST, GENERAL_SIGNING_POLICY_VERSION } from "../domain/generalSigningPolicy.js";
import { assertGeneralSigningPolicy } from "../app/generalSigningPolicyVerification.js";
import { assertGeneralTransferFunds } from "../domain/generalTransferFunds.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { digest } from "./canonical.js";

const MAX_UINT = (1n << 256n) - 1n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const transferAbi = new Interface(["function transfer(address to, uint256 value) returns (bool)"]);
const OP_STACK = new Set(["eip155:8453", "eip155:10", "eip155:11155420"]);
const ARBITRUM = new Set(["eip155:42161", "eip155:421614"]);
const prepared = new WeakMap<object, { digest: string; createdAt: number }>();
type Asset = { kind: "native"; decimals: 18 } | { kind: "erc20"; address: string; decimals: number };
type Fee = { type: "legacy"; gasLimitAtomic: string; gasPriceAtomic: string; maxLayerFeeAtomic: string; policy: "standard" | "op-stack" | "arbitrum" }
  | { type: "eip1559"; gasLimitAtomic: string; maxFeePerGasAtomic: string; maxPriorityFeePerGasAtomic: string;
    maxLayerFeeAtomic: string; policy: "standard" | "op-stack" | "arbitrum" };

export interface GeneralTransferPreview {
  transferId: string;
  ownerId: string;
  accountId: string;
  accountAddress: string;
  networkId: string;
  chainId: string;
  asset: Asset;
  recipient: string;
  amountAtomic: string;
  nonce: number;
  fee: Fee;
  maxFeeExposureAtomic: string;
  unsignedTransaction: string;
  configVersion: number;
  signingPolicyVersion: number;
  signingPolicyDigest: string;
  expiresAt: number;
  digest: string;
}

function evmAddress(input: unknown): string {
  requireWallet(typeof input === "string" && /^0x[0-9a-fA-F]{40}$/.test(input), "INVALID_ADDRESS", "A valid EVM address is required.");
  try {
    const result = getAddress(input);
    requireWallet(!/^0x0{40}$/i.test(result), "INVALID_ADDRESS", "The zero address is not allowed.");
    return result.toLowerCase();
  } catch { throw new WalletError("INVALID_ADDRESS", "A valid EVM address is required."); }
}

export { evmAddress as normalizeGeneralTransferAddress };

/** Decimal input is converted without floating point or rounding. */
export function parseGeneralTransferAmount(input: string, decimals: number): string {
  requireWallet(typeof input === "string" && input.length <= 256 && /^\d+(?:\.\d+)?$/.test(input) &&
    Number.isInteger(decimals) && decimals >= 0 && decimals <= 255, "INVALID_AMOUNT", "A plain decimal amount is required.");
  const [whole, fraction = ""] = input.split(".");
  requireWallet(fraction.length <= decimals, "INVALID_AMOUNT", "The amount exceeds the asset precision.");
  const value = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((fraction || "0").padEnd(decimals || 1, "0"));
  requireWallet(value > 0n && value <= MAX_UINT, "INVALID_AMOUNT", "The amount is outside the allowed range.");
  return value.toString();
}

/** Input is supplied by the trusted transfer owner after fresh RPC checks and fee policy evaluation. */
export function prepareGeneralTransfer(input: {
  ownerId: string; accountId: string; accountAddress: string; networkId: string; asset: Asset;
  recipient: string; amountAtomic: string; nonce: number; fee: Fee; configVersion: number; now: number;
  assetBalanceAtomic: string; nativeBalanceAtomic: string; assetRiskAtomic: string; nativeRiskAtomic: string;
}): GeneralTransferPreview {
  assertGeneralSigningPolicy();
  const network = generalNetwork(input.networkId);
  assertGeneralSigningNetwork(network.id, BigInt(network.chainId));
  const accountAddress = evmAddress(input.accountAddress), recipient = evmAddress(input.recipient);
  requireWallet(typeof input.ownerId === "string" && UUID.test(input.ownerId) && typeof input.accountId === "string" && UUID.test(input.accountId) &&
    Number.isSafeInteger(input.nonce) && input.nonce >= 0 && Number.isSafeInteger(input.now) && input.now >= 0 &&
    input.now <= Number.MAX_SAFE_INTEGER - 60000 && Number.isSafeInteger(input.configVersion) && input.configVersion > 0,
  "INVALID_REQUEST", "Invalid transfer identity or timing.");
  requireWallet(input.asset && (input.asset.kind === "native" || input.asset.kind === "erc20") &&
    Number.isInteger(input.asset.decimals) && input.asset.decimals >= 0 && input.asset.decimals <= 255,
  "INVALID_ASSET", "Invalid transfer asset.");
  let asset: Asset;
  if (input.asset.kind === "native") {
    requireWallet(input.asset.decimals === 18, "INVALID_ASSET", "Invalid native asset precision.");
    asset = { kind: "native", decimals: 18 };
  } else asset = { kind: "erc20", address: evmAddress(input.asset.address), decimals: input.asset.decimals };
  const amount = positiveAtomic(input.amountAtomic);
  requireWallet(input.fee && (input.fee.type === "legacy" || input.fee.type === "eip1559"), "INVALID_FEE", "Invalid network fee.");
  const expectedPolicy = OP_STACK.has(network.id) ? "op-stack" : ARBITRUM.has(network.id) ? "arbitrum" : "standard";
  requireWallet(input.fee.policy === expectedPolicy, "INVALID_FEE", "The fee policy does not match the network.");
  const gas = positiveAtomic(input.fee.gasLimitAtomic), layerFee = atomic(input.fee.maxLayerFeeAtomic);
  requireWallet(expectedPolicy !== "arbitrum" || layerFee === 0n, "INVALID_FEE", "Arbitrum gas already includes its L1 component.");
  requireWallet(asset.kind !== "native" || gas >= 21000n, "INVALID_FEE", "The native transfer gas limit is invalid.");
  let gasPrice: bigint;
  let fee: Fee;
  if (input.fee.type === "legacy") {
    gasPrice = positiveAtomic(input.fee.gasPriceAtomic);
    fee = { type: "legacy", gasLimitAtomic: gas.toString(), gasPriceAtomic: gasPrice.toString(), maxLayerFeeAtomic: layerFee.toString(), policy: expectedPolicy };
  } else {
    gasPrice = positiveAtomic(input.fee.maxFeePerGasAtomic);
    const priority = atomic(input.fee.maxPriorityFeePerGasAtomic);
    requireWallet(priority <= gasPrice, "INVALID_FEE", "The priority fee exceeds the maximum fee.");
    fee = { type: "eip1559", gasLimitAtomic: gas.toString(), maxFeePerGasAtomic: gasPrice.toString(),
      maxPriorityFeePerGasAtomic: priority.toString(), maxLayerFeeAtomic: layerFee.toString(), policy: expectedPolicy };
  }
  const maxFee = gas * gasPrice + layerFee;
  requireWallet(maxFee <= MAX_UINT, "INVALID_FEE", "The maximum network fee exceeds uint256.");
  assertGeneralTransferFunds({ assetKind: asset.kind, amountAtomic: amount.toString(), assetBalanceAtomic: input.assetBalanceAtomic,
    nativeBalanceAtomic: input.nativeBalanceAtomic, assetRiskAtomic: input.assetRiskAtomic,
    nativeRiskAtomic: input.nativeRiskAtomic, maxFeeAtomic: maxFee.toString() });
  const transaction = Transaction.from({ type: fee.type === "legacy" ? 0 : 2, chainId: BigInt(network.chainId), nonce: input.nonce,
    to: asset.kind === "native" ? recipient : asset.address, value: asset.kind === "native" ? amount : 0n,
    data: asset.kind === "native" ? "0x" : transferAbi.encodeFunctionData("transfer", [recipient, amount]),
    gasLimit: gas, ...(fee.type === "legacy" ? { gasPrice } : { maxFeePerGas: gasPrice, maxPriorityFeePerGas: BigInt(fee.maxPriorityFeePerGasAtomic) }) });
  const frozen = { transferId: randomUUID(), ownerId: input.ownerId, accountId: input.accountId, accountAddress,
    networkId: network.id, chainId: String(network.chainId), asset, recipient, amountAtomic: amount.toString(), nonce: input.nonce,
    fee, maxFeeExposureAtomic: maxFee.toString(), unsignedTransaction: transaction.unsignedSerialized,
    configVersion: input.configVersion, signingPolicyVersion: GENERAL_SIGNING_POLICY_VERSION,
    signingPolicyDigest: GENERAL_SIGNING_POLICY_DIGEST, expiresAt: input.now + 60000 };
  const preview = { ...frozen, digest: digest(frozen) };
  prepared.set(preview, { digest: preview.digest, createdAt: input.now });
  return preview;
}

/** Only this process's original prepared object may enter a new signing flow. */
export function assertFreshGeneralPreparedPreview(preview: GeneralTransferPreview, now: number): void {
  const fact = preview && typeof preview === "object" ? prepared.get(preview) : undefined;
  requireWallet(fact && fact.digest === preview.digest && Number.isSafeInteger(now) && now >= fact.createdAt && now < preview.expiresAt,
    "TRANSFER_APPROVAL_EXPIRED", "The original transfer preparation is unavailable or expired.");
  assertGeneralTransferPreview(preview, fact.digest, now);
}

/** trustedDigest must come from the owner's one-use approval, never from renderer input. */
export function assertGeneralTransferPreview(preview: GeneralTransferPreview, trustedDigest: string, now: number): void {
  assertGeneralSigningPolicy();
  requireWallet(preview && typeof preview === "object", "INVALID_REQUEST", "Invalid transfer preview.");
  const { digest: expected, ...frozen } = preview;
  requireWallet(typeof trustedDigest === "string" && typeof expected === "string" && /^[0-9a-f]{64}$/.test(expected) &&
    expected === trustedDigest && digest(frozen) === expected &&
    preview.signingPolicyVersion === GENERAL_SIGNING_POLICY_VERSION && preview.signingPolicyDigest === GENERAL_SIGNING_POLICY_DIGEST &&
    Number.isSafeInteger(now) && Number.isSafeInteger(preview.expiresAt) && now < preview.expiresAt,
  "TRANSFER_APPROVAL_EXPIRED", "The transfer approval is invalid or expired.");
  const network = generalNetwork(preview.networkId);
  try {
    assertGeneralSigningNetwork(network.id, BigInt(preview.chainId));
    requireWallet(evmAddress(preview.accountAddress) === preview.accountAddress && evmAddress(preview.recipient) === preview.recipient &&
      preview.fee.policy === (OP_STACK.has(network.id) ? "op-stack" : ARBITRUM.has(network.id) ? "arbitrum" : "standard"),
    "INVALID_REQUEST", "The transfer identity or fee policy is invalid.");
    if (preview.asset.kind === "erc20") requireWallet(evmAddress(preview.asset.address) === preview.asset.address,
      "INVALID_ASSET", "The token identity is invalid.");
    const tx = Transaction.from(preview.unsignedTransaction);
    requireWallet(tx.signature === null && tx.chainId === BigInt(network.chainId) && tx.nonce === preview.nonce &&
      tx.to?.toLowerCase() === (preview.asset.kind === "native" ? preview.recipient : preview.asset.address) &&
      tx.value === (preview.asset.kind === "native" ? BigInt(preview.amountAtomic) : 0n) &&
      tx.data === (preview.asset.kind === "native" ? "0x" : transferAbi.encodeFunctionData("transfer", [preview.recipient, BigInt(preview.amountAtomic)])),
    "INVALID_REQUEST", "The transfer encoding does not match its approval.");
    const gas = atomic(preview.fee.gasLimitAtomic);
    const unitPrice = preview.fee.type === "legacy" ? atomic(preview.fee.gasPriceAtomic) : atomic(preview.fee.maxFeePerGasAtomic);
    requireWallet(tx.gasLimit === gas && tx.type === (preview.fee.type === "legacy" ? 0 : 2) &&
      (preview.fee.policy !== "arbitrum" || atomic(preview.fee.maxLayerFeeAtomic) === 0n) &&
      (preview.fee.type === "legacy" ? tx.gasPrice === unitPrice : tx.maxFeePerGas === unitPrice &&
        tx.maxPriorityFeePerGas === atomic(preview.fee.maxPriorityFeePerGasAtomic)) &&
      gas * unitPrice + atomic(preview.fee.maxLayerFeeAtomic) === atomic(preview.maxFeeExposureAtomic),
    "INVALID_REQUEST", "The transfer fee does not match its approval.");
  } catch (error) {
    if (error instanceof WalletError && error.code === "LEGACY_NETWORK_RESERVED") throw error;
    throw new WalletError("INVALID_REQUEST", "The transfer encoding does not match its approval.");
  }
}
