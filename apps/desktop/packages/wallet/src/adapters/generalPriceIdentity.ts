import type { GeneralBalanceAsset } from "../app/generalBalances.js";
import type { GeneralPriceRequest } from "./generalPriceService.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { requireWallet } from "../domain/errors.js";

// CoinGecko asset_platforms, matched by chain_identifier; native IDs come from provider coin pages.
const NETWORKS = new Map<string, { platform: string; coin: string }>([
  ["eip155:1", { platform: "ethereum", coin: "ethereum" }],
  ["eip155:8453", { platform: "base", coin: "ethereum" }],
  ["eip155:42161", { platform: "arbitrum-one", coin: "ethereum" }],
  ["eip155:10", { platform: "optimistic-ethereum", coin: "ethereum" }],
  ["eip155:56", { platform: "binance-smart-chain", coin: "binancecoin" }],
  ["eip155:137", { platform: "polygon-pos", coin: "polygon-ecosystem-token" }],
  ["eip155:43114", { platform: "avalanche", coin: "avalanche-2" }],
]);

/** Maps a tracked asset by network and contract, never by display name or symbol. */
export function generalPriceRequest(networkId: string, asset: GeneralBalanceAsset): GeneralPriceRequest | null {
  const network = generalNetwork(networkId);
  requireWallet(asset && (asset.kind === "native" || asset.kind === "erc20"), "PRICE_INPUT_INVALID", "Price asset is invalid.");
  if (asset.kind === "erc20") requireWallet(typeof asset.contractAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(asset.contractAddress) &&
    !/^0x0{40}$/i.test(asset.contractAddress), "PRICE_INPUT_INVALID", "Price asset is invalid.");
  if (network.testnet) return null;
  const mapping = NETWORKS.get(network.id);
  requireWallet(mapping, "PRICE_INPUT_INVALID", "Price network mapping is unavailable.");
  if (asset.kind === "native") return { assetId: `${network.id}/native`, networkId: network.id,
    identity: { kind: "coin", id: mapping.coin } };
  const contract = asset.contractAddress.toLowerCase();
  return { assetId: `${network.id}/erc20:${contract}`, networkId: network.id,
    identity: { kind: "token", platform: mapping.platform, contract } };
}
