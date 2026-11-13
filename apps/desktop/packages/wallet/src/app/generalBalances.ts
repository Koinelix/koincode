import { requireWallet, WalletError } from "../domain/errors.js";
import { generalNetwork } from "../domain/generalNetworks.js";

export interface GeneralBalanceRpc {
  /** Trusted transport must abort network work when signal aborts. */
  call(method: string, params: readonly unknown[], signal: AbortSignal): Promise<unknown>;
}
export type GeneralBalanceAsset = { kind: "native" } | { kind: "erc20"; contractAddress: string; expectedDecimals?: number };
export interface GeneralBalanceItem {
  asset: GeneralBalanceAsset;
  amountAtomic: string | null;
  status: "fresh" | "stale" | "error" | "metadata_conflict";
  previous?: { blockNumber: string; blockHash: string; chainTimestamp: string; fetchedAt: string };
}
export interface GeneralBalanceSnapshot {
  networkId: string;
  address: string;
  blockNumber: string;
  blockHash: string;
  chainTimestamp: string;
  assets: GeneralBalanceItem[];
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const BALANCE_OF = "0x70a08231";

function quantity(value: unknown): string {
  requireWallet(typeof value === "string" && QUANTITY.test(value), "BALANCE_RPC_INVALID", "Invalid RPC quantity.");
  return BigInt(value).toString();
}

function block(value: unknown): { number: string; hash: string; timestamp: string } {
  requireWallet(value !== null && typeof value === "object" && !Array.isArray(value),
    "BALANCE_RPC_INVALID", "Invalid RPC block.");
  const row = value as Record<string, unknown>;
  requireWallet(typeof row.number === "string" && QUANTITY.test(row.number) &&
    typeof row.hash === "string" && HASH.test(row.hash), "BALANCE_RPC_INVALID", "Invalid RPC block identity.");
  return { number: row.number.toLowerCase(), hash: row.hash.toLowerCase(), timestamp: quantity(row.timestamp) };
}

async function boundedCall(rpc: GeneralBalanceRpc, method: string, params: readonly unknown[], parent: AbortSignal): Promise<unknown> {
  const deadline = AbortSignal.timeout(8000);
  const signal = AbortSignal.any([parent, deadline]);
  if (signal.aborted) throw new WalletError("BALANCE_READ_CANCELED", "Balance reading was canceled or timed out.");
  let remove = () => {};
  const canceled = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new WalletError("BALANCE_READ_CANCELED", "Balance reading was canceled or timed out."));
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([rpc.call(method, params, signal), canceled]);
  } finally {
    remove();
  }
}

/** Reads one network at a single verified block; it does not use the payment chain adapter or ledger. */
export async function readGeneralBalances(input: {
  networkId: string;
  address: string;
  assets: readonly GeneralBalanceAsset[];
  rpc: GeneralBalanceRpc;
  signal?: AbortSignal;
}): Promise<GeneralBalanceSnapshot> {
  const network = generalNetwork(input.networkId);
  requireWallet(typeof input.address === "string" && ADDRESS.test(input.address), "INVALID_ADDRESS", "Invalid EVM address.");
  requireWallet(Array.isArray(input.assets) && input.assets.length <= 20, "BALANCE_LIMIT_EXCEEDED", "Too many assets requested.");
  const address = input.address.toLowerCase();
  const seen = new Set<string>();
  const assets = input.assets.map((asset): GeneralBalanceAsset => {
    requireWallet(asset && (asset.kind === "native" || asset.kind === "erc20"), "INVALID_ASSET", "Invalid asset identity.");
    if (asset.kind === "native") {
      requireWallet(!seen.has("native"), "INVALID_ASSET", "Duplicate asset identity.");
      seen.add("native");
      return { kind: "native" };
    }
    requireWallet(typeof asset.contractAddress === "string" && ADDRESS.test(asset.contractAddress) &&
      !/^0x0{40}$/i.test(asset.contractAddress), "INVALID_ASSET", "Invalid token address.");
    const contractAddress = asset.contractAddress.toLowerCase();
    requireWallet(!seen.has(contractAddress), "INVALID_ASSET", "Duplicate asset identity.");
    seen.add(contractAddress);
    requireWallet(asset.expectedDecimals === undefined || (Number.isInteger(asset.expectedDecimals) &&
      asset.expectedDecimals >= 0 && asset.expectedDecimals <= 255), "INVALID_ASSET", "Invalid token precision.");
    return { kind: "erc20", contractAddress, ...(asset.expectedDecimals === undefined ? {} : { expectedDecimals: asset.expectedDecimals }) };
  });
  const totalDeadline = AbortSignal.timeout(20000);
  const signal = input.signal ? AbortSignal.any([input.signal, totalDeadline]) : totalDeadline;
  const chain = await boundedCall(input.rpc, "eth_chainId", [], signal);
  requireWallet(BigInt(quantity(chain)) === BigInt(network.chainId), "RPC_CHAIN_MISMATCH", "The RPC returned a different network.");

  for (let attempt = 0; attempt < 2; attempt++) {
    const initial = block(await boundedCall(input.rpc, "eth_getBlockByNumber", ["latest", false], signal));
    const items: GeneralBalanceItem[] = Array.from(assets, (asset) => ({
      asset, amountAtomic: null, status: "error",
    }));
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, assets.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= assets.length) return;
        const asset = assets[index];
        requireWallet(asset, "INVALID_ASSET", "The asset snapshot is incomplete.");
        try {
          let amountAtomic: string;
          if (asset.kind === "native") {
            amountAtomic = quantity(await boundedCall(input.rpc, "eth_getBalance", [address, initial.number], signal));
          } else {
            if (asset.expectedDecimals !== undefined) {
              const code = await boundedCall(input.rpc, "eth_getCode", [asset.contractAddress, initial.number], signal);
              requireWallet(typeof code === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(code) && code.length <= 49154,
                "TOKEN_METADATA_UNAVAILABLE", "The token contract is unavailable.");
              const decimals = await boundedCall(input.rpc, "eth_call", [{ to: asset.contractAddress, data: "0x313ce567" }, initial.number], signal);
              requireWallet(typeof decimals === "string" && WORD.test(decimals), "TOKEN_METADATA_UNAVAILABLE", "The token precision is unavailable.");
              requireWallet(BigInt(decimals) === BigInt(asset.expectedDecimals), "TOKEN_METADATA_CONFLICT", "The token precision does not match the catalog.");
            }
            const data = BALANCE_OF + address.slice(2).padStart(64, "0");
            const value = await boundedCall(input.rpc, "eth_call", [{ to: asset.contractAddress, data }, initial.number], signal);
            requireWallet(typeof value === "string" && WORD.test(value), "BALANCE_RPC_INVALID", "Invalid token balance.");
            amountAtomic = BigInt(value).toString();
          }
          items[index] = { asset, amountAtomic, status: "fresh" };
        } catch (error) {
          if (signal.aborted) throw new WalletError("BALANCE_READ_CANCELED", "Balance reading was canceled or timed out.");
          items[index] = { asset, amountAtomic: null,
            status: error instanceof WalletError && error.code === "TOKEN_METADATA_CONFLICT" ? "metadata_conflict" : "error" };
        }
      }
    }));
    const final = block(await boundedCall(input.rpc, "eth_getBlockByNumber", [initial.number, false], signal));
    const finalChain = await boundedCall(input.rpc, "eth_chainId", [], signal);
    requireWallet(!signal.aborted, "BALANCE_READ_CANCELED", "Balance reading was canceled or timed out.");
    requireWallet(BigInt(quantity(finalChain)) === BigInt(network.chainId), "RPC_CHAIN_MISMATCH", "The RPC returned a different network.");
    if (final.number === initial.number && final.hash === initial.hash && final.timestamp === initial.timestamp) {
      return { networkId: network.id, address, blockNumber: quantity(initial.number), blockHash: initial.hash,
        chainTimestamp: initial.timestamp, assets: items };
    }
  }
  throw new WalletError("BALANCE_REORG", "The balance block changed during reading.");
}
