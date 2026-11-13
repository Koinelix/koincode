import { HDNodeWallet, Mnemonic, Wallet } from "ethers";
import { WalletError, requireWallet } from "../domain/errors.js";

import { generalDerivationPath } from "../domain/generalDerivation.js";
export { GENERAL_DERIVATION_PATH } from "../domain/generalDerivation.js";

export interface GeneralKeyPreview {
  address: string;
  sourceType: "mnemonic" | "private_key";
  derivationPath?: string;
}

/** Internal worker-side preview only; admission, secret storage and confirmation are separate. */
export function previewGeneralMnemonic(input: unknown, accountIndex = 0): GeneralKeyPreview {
  requireWallet(typeof input === "string" && Buffer.byteLength(input, "utf8") <= 1024,
    "INVALID_MNEMONIC", "The mnemonic input is invalid.");
  const phrase = input.normalize("NFKD").trim().toLowerCase().split(/\s+/).join(" ");
  requireWallet(phrase.split(" ").length === 12 && Mnemonic.isValidMnemonic(phrase),
    "INVALID_MNEMONIC", "A valid twelve-word English mnemonic is required.");
  try {
    const path = generalDerivationPath(accountIndex);
    const wallet = HDNodeWallet.fromPhrase(phrase, undefined, path);
    return { address: wallet.address, sourceType: "mnemonic", derivationPath: path };
  } catch {
    throw new WalletError("INVALID_MNEMONIC", "The mnemonic could not be derived.");
  }
}

/** Never include the supplied private key or library exception text in the result or error. */
export function previewGeneralPrivateKey(input: unknown): GeneralKeyPreview {
  requireWallet(typeof input === "string" && Buffer.byteLength(input, "utf8") <= 256,
    "INVALID_PRIVATE_KEY", "The private key input is invalid.");
  const text = input.trim();
  requireWallet(/^(?:0x)?[0-9a-fA-F]{64}$/.test(text),
    "INVALID_PRIVATE_KEY", "A valid EVM private key is required.");
  try {
    const wallet = new Wallet(text.startsWith("0x") ? text : `0x${text}`);
    return { address: wallet.address, sourceType: "private_key" };
  } catch {
    throw new WalletError("INVALID_PRIVATE_KEY", "A valid EVM private key is required.");
  }
}
