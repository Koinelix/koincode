declare const __KOINCODE_X402_MAINNET__: boolean;

/** The host selects one immutable network before opening any wallet material. */
export function desktopPaymentNetwork() {
  if (typeof __KOINCODE_X402_MAINNET__ !== "boolean") {
    throw new Error("The fixed wallet network is missing from this build.");
  }
  return __KOINCODE_X402_MAINNET__
    ? { network: "eip155:8453" as const, namespace: "mainnet" as const, helper: "keychain-helper-mainnet" }
    : { network: "eip155:84532" as const, namespace: "m4-testnet" as const, helper: "keychain-helper-m4-testnet" };
}
