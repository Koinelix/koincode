export class WalletError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

export function requireWallet(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new WalletError(code, message);
}
