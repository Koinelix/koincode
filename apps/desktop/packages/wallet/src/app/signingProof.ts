import { WalletError } from "../domain/errors.js";
const unsigned = new WeakSet<object>();
export function unsignedSigningFailure(error: unknown): WalletError {
  const wrapped =
    error instanceof WalletError
      ? new WalletError(error.code, error.message)
      : new WalletError(
          "WALLET_SIGNING_FAILED",
          "Signing failed before producing an authorization.",
        );
  unsigned.add(wrapped);
  return wrapped;
}
export function isUnsignedSigningFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && unsigned.has(error);
}
