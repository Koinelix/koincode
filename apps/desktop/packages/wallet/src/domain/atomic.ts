import { requireWallet } from "./errors.js";

const UINT256_MAX = (1n << 256n) - 1n;
export function atomic(value: string): bigint {
  requireWallet(
    typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value),
    "INVALID_AMOUNT",
    "An atomic integer string is required.",
  );
  const parsed = BigInt(value);
  requireWallet(parsed <= UINT256_MAX, "INVALID_AMOUNT", "The amount exceeds uint256.");
  return parsed;
}

export function positiveAtomic(value: string): bigint {
  const parsed = atomic(value);
  requireWallet(parsed > 0n, "INVALID_AMOUNT", "The payment amount must be positive.");
  return parsed;
}

export function signedAtomic(value: string): bigint {
  requireWallet(typeof value === "string", "INVALID_AMOUNT", "An integer delta is required.");
  return value.startsWith("-") ? -positiveAtomic(value.slice(1)) : atomic(value);
}

export function timestamp(value: number): number {
  requireWallet(
    Number.isSafeInteger(value) && value >= 0,
    "INVALID_TIME",
    "A trusted timestamp is required.",
  );
  return value;
}
