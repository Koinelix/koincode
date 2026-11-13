import { requireWallet } from "./errors.js";

/** Asset-view network identities. This registry does not grant payment or signing capability. */
export const GENERAL_NETWORKS = Object.freeze([
  { id: "eip155:1", chainId: 1, nativeSymbol: "ETH", testnet: false },
  { id: "eip155:11155111", chainId: 11155111, nativeSymbol: "ETH", testnet: true },
  { id: "eip155:8453", chainId: 8453, nativeSymbol: "ETH", testnet: false },
  { id: "eip155:84532", chainId: 84532, nativeSymbol: "ETH", testnet: true },
  { id: "eip155:42161", chainId: 42161, nativeSymbol: "ETH", testnet: false },
  { id: "eip155:421614", chainId: 421614, nativeSymbol: "ETH", testnet: true },
  { id: "eip155:10", chainId: 10, nativeSymbol: "ETH", testnet: false },
  { id: "eip155:11155420", chainId: 11155420, nativeSymbol: "ETH", testnet: true },
  { id: "eip155:56", chainId: 56, nativeSymbol: "BNB", testnet: false },
  { id: "eip155:97", chainId: 97, nativeSymbol: "BNB", testnet: true },
  { id: "eip155:137", chainId: 137, nativeSymbol: "POL", testnet: false },
  { id: "eip155:80002", chainId: 80002, nativeSymbol: "POL", testnet: true },
  { id: "eip155:43114", chainId: 43114, nativeSymbol: "AVAX", testnet: false },
  { id: "eip155:43113", chainId: 43113, nativeSymbol: "AVAX", testnet: true },
].map((network) => Object.freeze(network)));

export type GeneralNetwork = (typeof GENERAL_NETWORKS)[number];

export function generalNetwork(id: unknown): GeneralNetwork {
  const network = GENERAL_NETWORKS.find((candidate) => candidate.id === id);
  requireWallet(network, "NETWORK_NOT_SUPPORTED", "The general-wallet network is not supported.");
  return network;
}
