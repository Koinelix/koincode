import { HDNodeWallet, Wallet, verifyTypedData } from "ethers";
import type { GeneralKeySource } from "../app/generalState.js";
import { generalSourceCommitment } from "../app/generalState.js";
import { requireWallet } from "../domain/errors.js";
import { generalDerivationIndex, generalDerivationPath } from "../domain/generalDerivation.js";
import { openGeneralSecret } from "./generalSecretEnvelope.js";
import { openGeneralPrivateKey } from "./generalPrivateKeyKeystore.js";
import { validateGeneralExactPayment, generalExactPaymentDigest, generalExactPaymentTypedData, type GeneralExactPayment } from "./generalExactPayment.js";
export type GeneralExactCryptoInput = { ownerId: string; source: GeneralKeySource; key: Uint8Array; intent: GeneralExactPayment };
/** Worker-private primitive. The actual broker/Host validates the stored source
 * and genuine payment-owner peer separately; supplied metadata grants nothing.
 * No plaintext key, phrase, arbitrary signer or typed-data input is returned. */
export async function prepareGeneralExactCrypto(input: GeneralExactCryptoInput) {
  requireWallet(input && Object.keys(input).sort().join() === "intent,key,ownerId,source" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.ownerId) &&
    input.key instanceof Uint8Array && input.key.byteLength === 32, "PERMIT_MISMATCH", "The exact-payment material is invalid.");
  const started = performance.now(), intent = validateGeneralExactPayment(input.intent), source = structuredClone(input.source);
  const digest = generalExactPaymentDigest(intent);
  requireWallet(source && source.status === "ready" && ["mnemonic", "private_key"].includes(source.sourceType) &&
    source.id === intent.source.sourceId && source.keyRef === `source-key:${source.id}` && source.address === intent.authorization.payer &&
    generalSourceCommitment(source) === intent.source.sourceCommitment && typeof source.protectedMaterial === "string" &&
    Buffer.byteLength(source.protectedMaterial) <= 8192, "PERMIT_MISMATCH", "The source does not match the frozen payment.");
  const key = Uint8Array.from(input.key); let account: Wallet | HDNodeWallet | undefined;
  try {
    account = source.sourceType === "mnemonic" ? HDNodeWallet.fromPhrase(await openGeneralSecret({ ownerId: input.ownerId,
      keySourceId: source.id, sourceType: "mnemonic", address: source.address, derivationPath: source.derivationPath }, source.protectedMaterial, key), undefined, generalDerivationPath(generalDerivationIndex(source.derivationPath))) :
      new Wallet(await openGeneralPrivateKey(source.address, source.protectedMaterial, key));
  } finally { key.fill(0); input.key.fill(0); }
  let consumed = false, closed = false, last = started;
  const current = () => {
    const now = performance.now();
    requireWallet(!closed && now >= last && now - started < 30000 && intent.authorization.validBefore > Math.floor(Date.now() / 1000),
      "GENERAL_OPERATION_CANCELED", "The original exact-payment preparation expired."); last = now;
  };
  current(); requireWallet(account.address.toLowerCase() === source.address, "PERMIT_MISMATCH", "The decrypted account does not match.");
  return Object.freeze({ digest,
    commit: async (expected: string): Promise<string> => {
      current(); requireWallet(!consumed, "PERMIT_MISMATCH", "The one-use payment commitment was already consumed."); consumed = true;
      requireWallet(expected === digest, "PERMIT_MISMATCH", "The one-use payment commitment does not match.");
      const data = generalExactPaymentTypedData(intent), signature = await account!.signTypedData(data.domain, data.types, data.message);
      current(); requireWallet(verifyTypedData(data.domain, data.types, data.message, signature).toLowerCase() === source.address,
        "PERMIT_MISMATCH", "The exact-payment signature does not match.");
      return signature;
    },
    close: () => { closed = true; account = undefined; },
  });
}
