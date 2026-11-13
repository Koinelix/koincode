import { decryptKeystoreJson, encryptKeystoreJson, Wallet } from "ethers";
import { WalletError, requireWallet } from "../domain/errors.js";
import { validateKeystoreForRestore } from "./backup-crypto.js";
import { previewGeneralPrivateKey } from "./generalKeyPreview.js";

function invalid(): never {
  throw new WalletError("GENERAL_SECRET_INVALID", "The protected wallet material could not be verified.");
}
function validate(address: string, key: Uint8Array): void {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address) ||
      !(key instanceof Uint8Array) || key.byteLength !== 32) invalid();
}

/** Caller owns the random protected key and must bind the keystore and source identity in its state commitment. */
export async function sealGeneralPrivateKey(address: string, privateKey: string, key: Uint8Array): Promise<string> {
  validate(address, key);
  const preview = previewGeneralPrivateKey(privateKey);
  requireWallet(preview.address.toLowerCase() === address.toLowerCase(),
    "GENERAL_SECRET_INVALID", "The protected wallet material could not be verified.");
  const password = Uint8Array.from(key);
  try {
    const text = privateKey.trim();
    const wallet = new Wallet(text.startsWith("0x") ? text : `0x${text}`);
    const keystore = await encryptKeystoreJson({ address: wallet.address, privateKey: wallet.privateKey }, password,
      { scrypt: { N: 131072, r: 8, p: 1 } });
    validateKeystoreForRestore(keystore);
    return keystore;
  } catch { return invalid(); }
  finally { password.fill(0); }
}

/** Worker only. Plaintext leaves the protected owner only through authenticated sensitive export, never model or ordinary IPC. */
export async function openGeneralPrivateKey(address: string, keystore: string, key: Uint8Array): Promise<string> {
  validate(address, key);
  const password = Uint8Array.from(key);
  try {
    validateKeystoreForRestore(keystore);
    const wallet = await decryptKeystoreJson(keystore, password);
    if (wallet.address.toLowerCase() !== address.toLowerCase() ||
        new Wallet(wallet.privateKey).address.toLowerCase() !== address.toLowerCase()) invalid();
    return wallet.privateKey;
  } catch { return invalid(); }
  finally { password.fill(0); }
}
