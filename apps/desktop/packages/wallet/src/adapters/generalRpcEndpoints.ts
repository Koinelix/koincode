import { generalNetwork } from "../domain/generalNetworks.js";
import { requireWallet } from "../domain/errors.js";

/** Versioned built-in read endpoints. They never configure legacy x402 or imply signing support. */
export const GENERAL_RPC_CONFIG_VERSION = 1;
const endpoints: Readonly<Record<string, string>> = Object.freeze({
  "eip155:1": "https://ethereum-rpc.publicnode.com",
  "eip155:11155111": "https://ethereum-sepolia-rpc.publicnode.com",
  "eip155:8453": "https://mainnet.base.org",
  "eip155:84532": "https://sepolia.base.org",
  "eip155:42161": "https://arb1.arbitrum.io/rpc",
  "eip155:421614": "https://sepolia-rollup.arbitrum.io/rpc",
  "eip155:10": "https://mainnet.optimism.io",
  "eip155:11155420": "https://sepolia.optimism.io",
  "eip155:56": "https://bsc-dataseed.bnbchain.org",
  "eip155:97": "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
  "eip155:137": "https://polygon.drpc.org",
  "eip155:80002": "https://polygon-amoy.drpc.org",
  "eip155:43114": "https://api.avax.network/ext/bc/C/rpc",
  "eip155:43113": "https://api.avax-test.network/ext/bc/C/rpc",
});

type Candidate = Readonly<{ id: string; provider: string; endpoint: string }>;
const alternatives: Readonly<Record<string, readonly Candidate[]>> = Object.freeze({
  "eip155:97": Object.freeze([Object.freeze({ id: "bnb-testnet-official", provider: "BNB Chain", endpoint: "https://bsc-testnet-dataseed.bnbchain.org" })]),
  "eip155:137": Object.freeze([Object.freeze({ id: "polygon-tenderly", provider: "Tenderly", endpoint: "https://tenderly.rpc.polygon.community" })]),
});

/** Fixed public candidates are display data, not consent to send an account address. */
export function generalRpcChoices(networkId: string): readonly Candidate[] {
  const network = generalNetwork(networkId), endpoint = endpoints[network.id];
  requireWallet(endpoint, "RPC_ENDPOINT_INVALID", "The network endpoint is unavailable.");
  return [{ id: "default", provider: "Built-in", endpoint }, ...(alternatives[network.id] ?? [])].map((candidate) => ({ ...candidate }));
}

/** A URL is selected by fixed chain and choice identities, never by a merchant or model. */
export function generalRpcEndpoint(networkId: string, rpcChoice = "default"): string {
  const network = generalNetwork(networkId);
  const value = generalRpcChoices(network.id).find((candidate) => candidate.id === rpcChoice);
  requireWallet(value, "RPC_ENDPOINT_INVALID", "The network endpoint is unavailable.");
  return value.endpoint;
}
