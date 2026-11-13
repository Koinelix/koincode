import { atomic, positiveAtomic, timestamp } from "./atomic.js";
import { requireWallet } from "./errors.js";
import { networkConfig } from "./networks.js";
import type { ExactAuthorization } from "./model.js";

export const PERMIT2_ADDRESS = "0x000000000022d473030f116ddee9f6b43ac78ba3";
export const UPTO_PROXY_ADDRESS = "0x4020a4f3b7b90cca423b9fabcc0ce57c6c240002";
export interface UptoDetails {
  facilitator: string;
  permitNonce: string | null;
}
export interface UptoAuthorization extends ExactAuthorization {
  upto: UptoDetails;
}
export const UPTO_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
  Witness: [{ name: "to", type: "address" }, { name: "facilitator", type: "address" }, { name: "validAfter", type: "uint256" }],
};
export const USDC_PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" }, { name: "spender", type: "address" },
    { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
};

/** Validates only the fixed payment intent; it never grants signing authority. */
export function validateUptoAuthorization(value: UptoAuthorization): void {
  const config = networkConfig(value.network);
  requireWallet(value.asset === config.asset &&
    [value.payer, value.payTo, value.upto.facilitator].every(address => /^0x[0-9a-f]{40}$/.test(address) && !/^0x0{40}$/.test(address)) &&
    /^0x[0-9a-f]{64}$/.test(value.nonce), "PERMIT_MISMATCH", "The upto payment identity is invalid.");
  positiveAtomic(value.amountAtomic);
  timestamp(value.validAfter); timestamp(value.validBefore);
  requireWallet(value.validBefore > value.validAfter && value.validBefore - value.validAfter <= 1050,
    "AUTHORIZATION_WINDOW_INVALID", "The upto payment window exceeds its bound.");
  if (value.upto.permitNonce !== null) atomic(value.upto.permitNonce);
}

export function uptoTypedData(value: UptoAuthorization) {
  validateUptoAuthorization(value);
  return {
    domain: { name: "Permit2", chainId: networkConfig(value.network).chainId, verifyingContract: PERMIT2_ADDRESS },
    types: UPTO_TYPES,
    primaryType: "PermitWitnessTransferFrom" as const,
    message: {
      permitted: { token: value.asset, amount: value.amountAtomic }, spender: UPTO_PROXY_ADDRESS,
      nonce: BigInt(value.nonce).toString(), deadline: String(value.validBefore),
      witness: { to: value.payTo, facilitator: value.upto.facilitator, validAfter: String(value.validAfter) },
    },
  };
}

export function usdcPermitTypedData(value: UptoAuthorization) {
  validateUptoAuthorization(value);
  requireWallet(value.upto.permitNonce !== null, "PERMIT_MISMATCH", "This payment has no permit authorization.");
  const config = networkConfig(value.network);
  return {
    domain: { name: config.domainName, version: config.domainVersion, chainId: config.chainId, verifyingContract: config.asset },
    types: USDC_PERMIT_TYPES,
    primaryType: "Permit" as const,
    message: { owner: value.payer, spender: PERMIT2_ADDRESS, value: value.amountAtomic,
      nonce: value.upto.permitNonce, deadline: String(value.validBefore) },
  };
}

/** Compare the complete fixed schema and message against a trusted frozen quote. */
export function parseUptoTypedData(input: unknown, expected: UptoAuthorization): UptoAuthorization {
  validateUptoAuthorization(expected);
  const normalize = (value: unknown): string => JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString();
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
  requireWallet(normalize(input) === normalize(uptoTypedData(expected)), "PERMIT_MISMATCH", "The upto typed data differs from its frozen intent.");
  return structuredClone(expected);
}
