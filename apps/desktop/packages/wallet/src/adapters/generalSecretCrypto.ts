import { signAllowance } from "../domain/allowanceTransaction.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { HDNodeWallet, Mnemonic, Transaction, Wallet, keccak256 } from "ethers";
import { WalletError, requireWallet } from "../domain/errors.js";
import { previewGeneralMnemonic, previewGeneralPrivateKey } from "./generalKeyPreview.js";
import { openGeneralSecret, sealGeneralSecret } from "./generalSecretEnvelope.js";
import { openGeneralPrivateKey, sealGeneralPrivateKey } from "./generalPrivateKeyKeystore.js";
import { assertGeneralTransferPreview, type GeneralTransferPreview } from "./generalTransferIntent.js";

import { generalDerivationIndex, generalDerivationPath } from "../domain/generalDerivation.js";
interface Source { ownerId: string; keySourceId: string; key: Uint8Array; derivationPath?: string }
export type GeneralSecretJob =
  | (Source & { operation: "sign_allowance"; sourceType: "mnemonic" | "private_key"; address: string; protectedMaterial: string;
    tx: import("../domain/allowanceTransaction.js").AllowanceTransaction })
  | (Source & { operation: "create" })
  | (Source & { operation: "import_mnemonic"; phrase: string; accountIndex?: number })
  | (Source & { operation: "import_private_key"; privateKey: string })
  | (Source & { operation: "reveal"; address: string; envelope: string })
  | (Source & { operation: "export_private_key"; sourceType: "mnemonic" | "private_key"; address: string; protectedMaterial: string })
  | (Source & { operation: "verify"; address: string; envelope: string; positions: number[]; words: string[] })
  | (Source & { operation: "sign_transaction"; sourceType: "mnemonic" | "private_key"; address: string;
    protectedMaterial: string; preview: GeneralTransferPreview; approvedDigest: string; riskId: string });

export interface GeneralStagedSource {
  sourceType: "mnemonic" | "private_key";
  address: string;
  derivationPath?: string;
  protectedMaterial: string;
}

/** Executes only in the new wallet's bounded worker. No create/import result contains plaintext. */
export async function executeGeneralSecretJob(job: GeneralSecretJob): Promise<unknown> {
  requireWallet(job && /^[A-Za-z0-9_-]{1,80}$/.test(job.ownerId) && /^[A-Za-z0-9_-]{1,80}$/.test(job.keySourceId) &&
    job.key instanceof Uint8Array && job.key.byteLength === 32, "GENERAL_SECRET_INVALID", "Invalid protected wallet material.");
  const key = Uint8Array.from(job.key);
  try {
    if (job.operation === "create" || job.operation === "import_mnemonic") {
      let phrase: string;
      if (job.operation === "create") {
        const entropy = randomBytes(16);
        try { phrase = Mnemonic.entropyToPhrase(entropy); }
        finally { entropy.fill(0); }
      } else phrase = job.phrase;
      const preview = previewGeneralMnemonic(phrase, job.operation === "import_mnemonic" ? job.accountIndex ?? 0 : 0);
      const protectedMaterial = await sealGeneralSecret({ ownerId: job.ownerId, keySourceId: job.keySourceId,
        sourceType: "mnemonic", address: preview.address, derivationPath: preview.derivationPath }, phrase, key);
      return { ...preview, protectedMaterial } satisfies GeneralStagedSource;
    }
    if (job.operation === "import_private_key") {
      const preview = previewGeneralPrivateKey(job.privateKey);
      const protectedMaterial = await sealGeneralPrivateKey(preview.address, job.privateKey, key);
      return { ...preview, protectedMaterial } satisfies GeneralStagedSource;
    }
    if (job.operation === "export_private_key" || job.operation === "sign_allowance") {
      requireWallet((job.sourceType === "mnemonic" || job.sourceType === "private_key") && typeof job.address === "string" &&
        typeof job.protectedMaterial === "string" && job.protectedMaterial.length <= 8192,
      "GENERAL_SECRET_INVALID", "The export identity is invalid.");
      const account = job.sourceType === "mnemonic"
        ? HDNodeWallet.fromPhrase(await openGeneralSecret({ ownerId: job.ownerId, keySourceId: job.keySourceId,
          sourceType: "mnemonic", address: job.address, derivationPath: job.derivationPath }, job.protectedMaterial, key), undefined, generalDerivationPath(generalDerivationIndex(job.derivationPath)))
        : new Wallet(await openGeneralPrivateKey(job.address, job.protectedMaterial, key));
      requireWallet(account.address.toLowerCase() === job.address.toLowerCase(), "GENERAL_SECRET_INVALID", "The export account does not match.");
      if (job.operation === "sign_allowance") return signAllowance(account, job.tx);
      return { privateKey: account.privateKey };
    }
    if (job.operation === "sign_transaction") {
      requireWallet((job.sourceType === "mnemonic" || job.sourceType === "private_key") && typeof job.address === "string" &&
        typeof job.protectedMaterial === "string" && job.protectedMaterial.length <= 8192 &&
        job.preview?.ownerId === job.ownerId && job.preview.accountId === job.keySourceId &&
        job.preview.accountAddress === job.address.toLowerCase() && /^[0-9a-f-]{36}$/.test(job.riskId),
      "GENERAL_SECRET_INVALID", "The signing identity is invalid.");
      assertGeneralTransferPreview(job.preview, job.approvedDigest, Math.floor(performance.now()));
      const account = job.sourceType === "mnemonic"
        ? HDNodeWallet.fromPhrase(await openGeneralSecret({ ownerId: job.ownerId, keySourceId: job.keySourceId,
          sourceType: "mnemonic", address: job.address, derivationPath: job.derivationPath }, job.protectedMaterial, key), undefined, generalDerivationPath(generalDerivationIndex(job.derivationPath)))
        : new Wallet(await openGeneralPrivateKey(job.address, job.protectedMaterial, key));
      requireWallet(account.address.toLowerCase() === job.address.toLowerCase(), "GENERAL_SECRET_INVALID", "The signing account does not match.");
      assertGeneralTransferPreview(job.preview, job.approvedDigest, Math.floor(performance.now()));
      const unsigned = Transaction.from(job.preview.unsignedTransaction);
      const transaction = { type: unsigned.type, chainId: unsigned.chainId, nonce: unsigned.nonce,
        to: unsigned.to, value: unsigned.value, data: unsigned.data, gasLimit: unsigned.gasLimit,
        ...(unsigned.type === 0 ? { gasPrice: unsigned.gasPrice } :
          { maxFeePerGas: unsigned.maxFeePerGas, maxPriorityFeePerGas: unsigned.maxPriorityFeePerGas }) };
      const signed = await account.signTransaction(transaction);
      const verified = Transaction.from(signed), transactionHash = keccak256(signed).toLowerCase();
      requireWallet(verified.from?.toLowerCase() === job.address.toLowerCase() &&
        verified.unsignedSerialized === job.preview.unsignedTransaction && verified.hash?.toLowerCase() === transactionHash,
      "GENERAL_SECRET_INVALID", "The signed transaction does not match its frozen intent.");
      return { signedTransaction: signed, transactionHash };
    }
    if (job.operation !== "reveal" && job.operation !== "verify")
      throw new WalletError("GENERAL_SECRET_INVALID", "Invalid protected wallet material.");
    const identity = { ownerId: job.ownerId, keySourceId: job.keySourceId, sourceType: "mnemonic" as const, address: job.address, derivationPath: job.derivationPath };
    const phrase = await openGeneralSecret(identity, job.envelope, key);
    if (job.operation === "reveal") return { phrase };
    requireWallet(Array.isArray(job.positions) && job.positions.length === 3 && new Set(job.positions).size === 3 &&
      job.positions.every((position) => Number.isInteger(position) && position >= 0 && position < 12) &&
      Array.isArray(job.words) && job.words.length === 3 && job.words.every((word) => typeof word === "string" && Buffer.byteLength(word) <= 64),
    "GENERAL_SECRET_INVALID", "Invalid backup confirmation.");
    const actual = phrase.split(" ");
    let matches = true;
    for (let index = 0; index < 3; index++) {
      const wanted = Buffer.from(actual[job.positions[index]!]!, "utf8");
      const supplied = Buffer.from(job.words[index]!.normalize("NFKD").trim().toLowerCase(), "utf8");
      try { matches = (wanted.length === supplied.length && timingSafeEqual(wanted, supplied)) && matches; }
      finally { wanted.fill(0); supplied.fill(0); }
    }
    return { verified: matches };
  } finally { key.fill(0); }
}
