import type { Network } from "./model.js";
import { requireWallet } from "./errors.js";
export const NETWORKS = {
  "eip155:84532": {
    chainId: 84532,
    asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    assetDecimals: 6,
    // Display symbol. Never derive it from the EIP-712 domain name, which differs per network.
    assetSymbol: "USDC",
    domainName: "USDC",
    domainVersion: "2",
    endpoint: "https://sepolia.base.org",
  },
  "eip155:8453": {
    chainId: 8453,
    asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    assetDecimals: 6,
    assetSymbol: "USDC",
    domainName: "USD Coin",
    domainVersion: "2",
    endpoint: "https://mainnet.base.org",
  },
} as const;
export function networkConfig(network: Network) {
  requireWallet(
    Object.hasOwn(NETWORKS, network),
    "UNSUPPORTED_NETWORK",
    "The wallet network is not supported.",
  );
  return NETWORKS[network];
}
