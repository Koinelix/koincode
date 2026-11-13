import { requireWallet } from "./errors.js";
import { generalNetwork } from "./generalNetworks.js";

/** This restriction is independent of the existence or health of the legacy wallet. */
export const GENERAL_SIGNING_POLICY_VERSION = 3;
export const LEGACY_RESERVED_NETWORK = "eip155:84532";
/** Historical identity only; its original policy text is not established. */
export const LEGACY_GENERAL_SIGNING_POLICY_DIGEST = "10ad2d283d416c16eeb387a4bd32448f16734ff93100f0c9ce8f651e6dbc12fd";
export const PREVIOUS_GENERAL_SIGNING_POLICY_DIGEST = "b26d65dab4ce474656df07cd4da10904e553815ae3e42f3e41550c98629fc0a0";
export const GENERAL_SIGNING_POLICY_DIGEST = "bc4de042d0a1cf3d9ba868395d7759339fe9e6e6fbcc8874673caf92d5c7bc10";
const POLICY_TEXT = '{"format":"koincode-general-signing-policy","legacyReservedNetworks":["eip155:8453","eip155:84532"],"requireChainIdBinding":true,"version":3}';

/** Returns a detached copy so a caller cannot mutate the built-in policy definition. */
export function generalSigningPolicyBytes(): Uint8Array { return new TextEncoder().encode(POLICY_TEXT); }

/**
 * Validate a canonical network identity and the chain ID frozen into a transaction.
 * Passing this policy does not enable signing: admission, custody and risk checks remain required.
 */
export function assertGeneralSigningNetwork(networkId: unknown, transactionChainId: unknown): void {
  const network = generalNetwork(networkId);
  requireWallet(
    network.id !== LEGACY_RESERVED_NETWORK && network.id !== "eip155:8453",
    "LEGACY_NETWORK_RESERVED",
    "General-wallet signing is unavailable on the reserved payment networks.",
  );
  requireWallet(
    typeof transactionChainId === "bigint" && transactionChainId === BigInt(network.chainId),
    "RPC_CHAIN_MISMATCH",
    "The transaction chain does not match the selected network.",
  );
}

/** OP-stack extra fees are not yet bounded by the frozen transaction's gas cap. */
export function assertGeneralBoundedManualFee(networkId: string): void {
  const network = generalNetwork(networkId);
  requireWallet(!["eip155:8453", "eip155:10", "eip155:11155420"].includes(network.id),
    "GENERAL_FEE_CAP_UNAVAILABLE", "A verified manual transfer fee cap is unavailable for this network.");
}
