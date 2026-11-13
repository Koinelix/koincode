import { atomic, positiveAtomic } from "./atomic.js";
import { requireWallet } from "./errors.js";

export interface GeneralTransferFunds {
  assetKind: "native" | "erc20";
  amountAtomic: string;
  assetBalanceAtomic: string;
  nativeBalanceAtomic: string;
  assetRiskAtomic: string;
  nativeRiskAtomic: string;
  maxFeeAtomic: string;
}

/** Validate one fresh, already de-duplicated risk snapshot without changing a payment budget. */
export function assertGeneralTransferFunds(input: GeneralTransferFunds): void {
  requireWallet(input.assetKind === "native" || input.assetKind === "erc20", "INVALID_REQUEST", "Unsupported asset kind.");
  const amount = positiveAtomic(input.amountAtomic);
  const assetBalance = atomic(input.assetBalanceAtomic);
  const nativeBalance = atomic(input.nativeBalanceAtomic);
  const assetRisk = atomic(input.assetRiskAtomic);
  const nativeRisk = atomic(input.nativeRiskAtomic);
  const fee = atomic(input.maxFeeAtomic);

  if (input.assetKind === "native") {
    requireWallet(
      assetBalance === nativeBalance && assetRisk === nativeRisk,
      "TRANSFER_SNAPSHOT_CONFLICT",
      "Native asset and fee snapshots must describe the same balance and risk.",
    );
    requireWallet(fee + nativeRisk <= nativeBalance, "INSUFFICIENT_GAS_FUNDS", "Insufficient native funds for the fee and existing risk.");
    requireWallet(amount + fee + nativeRisk <= nativeBalance, "INSUFFICIENT_FUNDS", "Insufficient native funds for the transfer, fee and existing risk.");
    return;
  }

  requireWallet(fee + nativeRisk <= nativeBalance, "INSUFFICIENT_GAS_FUNDS", "Insufficient native funds for the fee and existing risk.");
  requireWallet(amount + assetRisk <= assetBalance, "INSUFFICIENT_FUNDS", "Insufficient token funds for the transfer and existing risk.");
}
