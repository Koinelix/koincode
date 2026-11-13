/** Build-time payment network injection; the network itself comes from config/network.json. */
export function resolveWalletNetworkBuildConfig(network, env) {
  if (!network || typeof network.x402Mainnet !== "boolean") {
    throw new Error("The KoinCode network must be resolved before the wallet build.");
  }
  if (env.NODE_ENV === "production" && network.x402Mainnet !== true) {
    throw new Error("Production builds require the mainnet payment network.");
  }
  return Object.freeze({ mainnet: network.x402Mainnet });
}
