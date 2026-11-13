/** Known native USDC deployments from the approved catalog. No symbol-based discovery. */
export const GENERAL_USDC_TOKENS = Object.freeze([
  { networkId: "eip155:1", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
  { networkId: "eip155:8453", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6 },
  { networkId: "eip155:84532", address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e", symbol: "USDC", decimals: 6 },
  { networkId: "eip155:42161", address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", symbol: "USDC", decimals: 6 },
  { networkId: "eip155:10", address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", symbol: "USDC", decimals: 6 },
  { networkId: "eip155:137", address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", symbol: "USDC", decimals: 6 },
  { networkId: "eip155:43114", address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", symbol: "USDC", decimals: 6 },
].map((item) => Object.freeze(item)));

export function generalUsdcToken(networkId: string) {
  return GENERAL_USDC_TOKENS.find((token) => token.networkId === networkId);
}

/** Other issuer-verified assets. These identities do not grant payment or transfer capability. */
export const GENERAL_ADDITIONAL_TOKENS = Object.freeze([
  { networkId: "eip155:1", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6 },
  { networkId: "eip155:43114", address: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", symbol: "USDT", decimals: 6 },
  { networkId: "eip155:42161", address: "0x912ce59144191c1204e64559fe8253a0e49e6548", symbol: "ARB", decimals: 18 },
].map((item) => Object.freeze(item)));

export function generalTokens(networkId: string) {
  return [...GENERAL_USDC_TOKENS, ...GENERAL_ADDITIONAL_TOKENS].filter((token) => token.networkId === networkId);
}
