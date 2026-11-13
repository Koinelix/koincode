import { GENERAL_NETWORKS } from "@koincode/wallet/general";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/, HASH = /^[0-9a-f]{64}$/, BLOCK_HASH = /^0x[0-9a-f]{64}$/;
const POLICY = "b26d65dab4ce474656df07cd4da10904e553815ae3e42f3e41550c98629fc0a0";
const unavailable = new Set(["eip155:84532", "eip155:8453", "eip155:10", "eip155:11155420"]);
const arbitrum = new Set(["eip155:42161", "eip155:421614"]);
const check = (value: unknown): void => { if (!value) throw new Error("GENERAL_TRANSFER_CONFIRMATION_INVALID"); };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  check(Object.keys(row).sort().join() === [...keys].sort().join()); return row;
}
function integer(value: unknown): number { check(Number.isSafeInteger(value) && (value as number) >= 0); return value as number; }
function atomic(value: unknown, positive = false): string {
  check(typeof value === "string" && /^(?:0|[1-9][0-9]{0,77})$/.test(value));
  check(BigInt(value as string) < (1n << 256n) && (!positive || BigInt(value as string) > 0n)); return value as string;
}
function address(value: unknown): string { check(typeof value === "string" && ADDRESS.test(value) && !/^0x0{40}$/.test(value)); return value as string; }
function format(value: string, decimals: number): string {
  if (!decimals) return value;
  const digits = value.padStart(decimals + 1, "0"), fraction = digits.slice(-decimals).replace(/0+$/, "");
  return digits.slice(0, -decimals) + (fraction ? `.${fraction}` : "");
}
function observation(value: unknown, networkId: string, now: number, gas: boolean) {
  const row = object(value, gas ? ["networkId", "blockNumber", "blockHash", "gasUnits", "feeAtPreviewGasPriceAtomic", "certainty", "observedAt", "expiresAt"] :
    ["networkId", "blockNumber", "blockHash", "gasPriceAtomic", "baseFeePerGasAtomic", "priorityFeePerGasAtomic", "observedAt", "expiresAt", "certainty"]);
  check(row.networkId === networkId && typeof row.blockHash === "string" && BLOCK_HASH.test(row.blockHash)); atomic(row.blockNumber);
  const observedAt = integer(row.observedAt), expiresAt = integer(row.expiresAt);
  check(observedAt <= now && expiresAt > now && expiresAt > observedAt && expiresAt - observedAt <= 20000);
  if (gas) {
    check(row.certainty === (arbitrum.has(networkId) ? "estimate_includes_l1_not_a_cap" : "estimate_at_block_not_a_cap"));
    atomic(row.gasUnits, true); atomic(row.feeAtPreviewGasPriceAtomic, true);
  } else {
    check(row.certainty === "node_observation_not_a_fee_cap"); atomic(row.gasPriceAtomic, true);
    if (row.baseFeePerGasAtomic !== null) atomic(row.baseFeePerGasAtomic);
    if (row.priorityFeePerGasAtomic !== null) atomic(row.priorityFeePerGasAtomic);
  }
  return row;
}

/** Display validation only; transaction validity, evidence and authority remain owned by the original wallet approval. */
function project(value: unknown, now: number) {
  check(Number.isSafeInteger(now) && now >= 0 && Buffer.byteLength(JSON.stringify(value)) <= 16384);
  const row = object(value, ["transferId", "ownerId", "accountId", "accountAddress", "networkId", "chainId", "asset", "recipient", "amountAtomic", "nonce",
    "fee", "maxFeeExposureAtomic", "digest", "configVersion", "signingPolicyVersion", "signingPolicyDigest", "expiresAt", "feeObservation", "gasObservation"]);
  for (const key of ["transferId", "ownerId", "accountId"]) check(typeof row[key] === "string" && ID.test(row[key] as string));
  const network = GENERAL_NETWORKS.find((item) => item.id === row.networkId);
  check(network && !unavailable.has(network.id) && row.chainId === String(network.chainId));
  check(row.signingPolicyVersion === 2 && row.signingPolicyDigest === POLICY && integer(row.configVersion) > 0);
  check(typeof row.digest === "string" && HASH.test(row.digest)); integer(row.nonce);
  const asset = row.asset as Record<string, unknown>;
  object(asset, asset?.kind === "native" ? ["kind", "decimals"] : ["kind", "address", "decimals"]);
  check(asset.kind === "native" || asset.kind === "erc20");
  const decimals = integer(asset.decimals); check(decimals <= 255 && (asset.kind !== "native" || decimals === 18));
  const contract = asset.kind === "erc20" ? address(asset.address) : null;
  const fee = row.fee as Record<string, unknown>;
  object(fee, fee?.type === "legacy" ? ["type", "policy", "gasLimitAtomic", "gasPriceAtomic", "maxLayerFeeAtomic"] :
    ["type", "policy", "gasLimitAtomic", "maxFeePerGasAtomic", "maxPriorityFeePerGasAtomic", "maxLayerFeeAtomic"]);
  check((fee.type === "legacy" || fee.type === "eip1559") && fee.policy === (arbitrum.has(network!.id) ? "arbitrum" : "standard") && fee.maxLayerFeeAtomic === "0");
  const gasLimit = atomic(fee.gasLimitAtomic, true), gasPrice = atomic(fee.type === "legacy" ? fee.gasPriceAtomic : fee.maxFeePerGasAtomic, true);
  const priorityFee = fee.type === "eip1559" ? atomic(fee.maxPriorityFeePerGasAtomic) : null;
  check(priorityFee === null || BigInt(priorityFee) <= BigInt(gasPrice));
  const amountAtomic = atomic(row.amountAtomic, true), maxFeeAtomic = atomic(row.maxFeeExposureAtomic, true);
  check(BigInt(maxFeeAtomic) === BigInt(gasLimit) * BigInt(gasPrice));
  const nativeExposure = BigInt(maxFeeAtomic) + (asset.kind === "native" ? BigInt(amountAtomic) : 0n);
  check(nativeExposure < (1n << 256n));
  const quote = observation(row.feeObservation, network!.id, now, false), gas = observation(row.gasObservation, network!.id, now, true);
  check(BigInt(gas.gasUnits as string) <= BigInt(gasLimit) && BigInt(gas.feeAtPreviewGasPriceAtomic as string) === BigInt(gas.gasUnits as string) * BigInt(gasPrice));
  const expiresAt = integer(row.expiresAt); check(expiresAt > now && expiresAt <= (quote.expiresAt as number) && expiresAt <= (gas.expiresAt as number));
  return Object.freeze({ transferId: row.transferId as string, digest: row.digest as string, expiresAt,
    networkId: network!.id, chainId: network!.chainId, nativeSymbol: network!.nativeSymbol, testnet: network!.testnet,
    accountAddress: address(row.accountAddress), recipient: address(row.recipient), assetKind: asset.kind as "native" | "erc20", contract, decimals,
    amountAtomic, amount: format(amountAtomic, decimals), maxFeeAtomic, maxFee: format(maxFeeAtomic, 18), nativeExposure: format(nativeExposure.toString(), 18),
    gasLimit, gasPrice, priorityFee, feeType: fee.type as "legacy" | "eip1559", nonce: row.nonce as number,
    gasUnits: gas.gasUnits as string, estimatedFee: format(gas.feeAtPreviewGasPriceAtomic as string, 18),
    quoteBlock: quote.blockNumber as string, quoteHash: quote.blockHash as string, estimateBlock: gas.blockNumber as string, estimateHash: gas.blockHash as string });
}

export function generalTransferConfirmationView(value: unknown, now: number) {
  try { return project(structuredClone(value), now); }
  catch { throw new Error("GENERAL_TRANSFER_CONFIRMATION_INVALID"); }
}
