import { requireWallet } from "./errors.js";
export const GENERAL_DERIVATION_PATH = "m/44'/60'/0'/0/0";
export function generalDerivationPath(index = 0): string {
  requireWallet(Number.isInteger(index) && index >= 0 && index <= 2147483647,
    "INVALID_REQUEST", "The account index is invalid.");
  return `m/44'/60'/0'/0/${index}`;
}
export function generalDerivationIndex(path: string = GENERAL_DERIVATION_PATH): number {
  const match = /^m\/44'\/60'\/0'\/0\/(0|[1-9][0-9]{0,9})$/.exec(path);
  requireWallet(match, "INVALID_REQUEST", "The account derivation path is invalid.");
  const index = Number(match[1]); generalDerivationPath(index); return index;
}
