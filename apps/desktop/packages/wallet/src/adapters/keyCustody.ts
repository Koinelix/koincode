import { uptoTypedData, usdcPermitTypedData, type UptoAuthorization } from "../domain/uptoAuthorization.js";
import { types } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { SigningKey, TypedDataEncoder, Wallet } from "ethers";
import type { BackupMetadata, KeyCustody, ManagedKey, ProtectedStore } from "../app/ports.js";
import type { ExactAuthorization, Network } from "../domain/model.js";
import { positiveAtomic, timestamp } from "../domain/atomic.js";
import { requireWallet } from "../domain/errors.js";
import { localPaymentSigner } from "./localPaymentSigner.js";
import { runCryptoTask } from "./cryptoTask.js";
import type { KeyJob } from "./keyCrypto.js";
import { unsignedSigningFailure } from "../app/signingProof.js";
import { networkConfig } from "../domain/networks.js";
const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};
export class ProtectedKeyCustody implements KeyCustody {
  readonly acquireSigningSlot = localPaymentSigner();
  constructor(private readonly protection: ProtectedStore) {}
  private task<T>(job: KeyJob, signal?: AbortSignal): Promise<T> {
    requireWallet(
      (!("keystore" in job) || Buffer.byteLength(job.keystore) <= 8192) &&
        (!("backup" in job) || Buffer.byteLength(job.backup) <= 16 * 1024 * 1024) &&
        (!("metadata" in job) || Buffer.byteLength(job.metadata.history) <= 8 * 1024 * 1024) &&
        (!("userPassword" in job) || Buffer.byteLength(job.userPassword) <= 1024),
      "CRYPTO_INPUT_INVALID",
      "The wallet cryptographic input exceeds its resource bounds.",
    );
    return runCryptoTask(
      new URL(
        import.meta.url.endsWith(".ts") ? "./keyCrypto.ts" : "./keyCrypto.js",
        import.meta.url,
      ).href,
      job,
      signal,
    );
  }
  private async password(key: ManagedKey): Promise<string> {
    requireWallet(key.kind !== "general_source", "GENERAL_PAYMENT_OWNER_REQUIRED", "This source requires the fixed protected payment owner.");
    const bytes = await this.protection.get(key.keyRef);
    requireWallet(
      bytes && bytes.length === 64,
      "PROTECTED_STORAGE_UNAVAILABLE",
      "The protected wallet key is unavailable.",
    );
    try {
      const text = Buffer.from(bytes).toString("utf8");
      requireWallet(
        /^[0-9a-f]{64}$/.test(text),
        "PROTECTED_STORAGE_UNAVAILABLE",
        "The protected wallet key is invalid.",
      );
      return text;
    } finally {
      bytes.fill(0);
    }
  }
  private async provision(
    network: Network,
    make: (password: string) => KeyJob,
    signal?: AbortSignal,
  ): Promise<{ key: ManagedKey; metadata?: BackupMetadata }> {
    const password = randomBytes(32).toString("hex");
    const result = await this.task<{
      address: string;
      keystore: string;
      metadata?: BackupMetadata;
    }>(make(password), signal);
    requireWallet(
      !signal?.aborted,
      "WALLET_OPERATION_ABORTED",
      "The wallet operation was canceled.",
    );
    const keyRef = "key:" + randomUUID();
    const bytes = Buffer.from(password);
    try {
      await this.protection.put(keyRef, bytes);
    } finally {
      bytes.fill(0);
    }
    return {
      key: { address: result.address, keystore: result.keystore, keyRef, network },
      ...(result.metadata ? { metadata: result.metadata } : {}),
    };
  }
  async create(network: Network, signal?: AbortSignal): Promise<ManagedKey> {
    requireWallet(
      network === "eip155:84532" || network === "eip155:8453",
      "UNSUPPORTED_NETWORK",
      "The wallet network is not supported.",
    );
    return (
      await this.provision(network, (password) => ({ operation: "create", password }), signal)
    ).key;
  }
  async importTestWallet(path: string, signal?: AbortSignal): Promise<ManagedKey> {
    requireWallet(
      isAbsolute(path) && path.length <= 4096,
      "TEST_WALLET_INVALID",
      "An absolute private test-wallet path is required.",
    );
    return (
      await this.provision(
        "eip155:84532",
        (password) => ({ operation: "import_test", password, path }),
        signal,
      )
    ).key;
  }
  async signAllowance(key: ManagedKey, tx: import("../domain/allowanceTransaction.js").AllowanceTransaction, signal: AbortSignal): Promise<string> {
    requireWallet(key.kind !== "general_source" && key.network === tx.network && key.address.toLowerCase() === tx.payer, "PERMIT_MISMATCH", "Incorrect approval source.");
    return this.task({ operation: "allowance", tx, password: await this.password(key), keystore: key.keystore }, signal);
  }
  async revealPrivateKey(key: ManagedKey, signal?: AbortSignal): Promise<string> {
    requireWallet(key.kind !== "general_source" && !signal?.aborted, "GENERAL_ACCOUNT_UNAVAILABLE", "The original private-key source is unavailable.");
    const result = await this.task<{ privateKey: string; address: string }>({ operation: "load",
      password: await this.password(key), keystore: key.keystore }, signal);
    requireWallet(!signal?.aborted && new Wallet(result.privateKey).address.toLowerCase() === key.address.toLowerCase(),
      "GENERAL_OPERATION_CANCELED", "The original private-key export is unavailable.");
    return result.privateKey;
  }
  async exportBackup(
    key: ManagedKey,
    metadata: BackupMetadata,
    userPassword: string,
    signal?: AbortSignal,
  ): Promise<string> {
    requireWallet(key.kind !== "general_source", "GENERAL_PAYMENT_OWNER_REQUIRED", "This source requires protected wallet export.");
    requireWallet(
      key.address.toLowerCase() === metadata.address.toLowerCase() &&
        key.network === metadata.network,
      "BACKUP_INVALID",
      "Backup identity does not match the wallet.",
    );
    const password = await this.password(key);
    return (
      await this.task<{ backup: string }>(
        { operation: "backup", password, keystore: key.keystore, metadata, userPassword },
        signal,
      )
    ).backup;
  }
  async restoreBackup(
    backup: string,
    userPassword: string,
    signal?: AbortSignal,
  ): Promise<{ key: ManagedKey; metadata: BackupMetadata }> {
    const result = await this.provision(
      "eip155:84532",
      (password) => ({ operation: "restore", password, backup, userPassword }),
      signal,
    );
    requireWallet(result.metadata, "BACKUP_INVALID", "Authenticated backup metadata is missing.");
    result.key.network = result.metadata.network;
    return { key: result.key, metadata: result.metadata };
  }
  async signAuthorization(
    keyInput: ManagedKey,
    authorizationInput: ExactAuthorization,
    finalCheck: (authorization: Readonly<ExactAuthorization>) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const attempt = { signingStarted: false };
    try {
      return await this.signChecked(keyInput, authorizationInput, finalCheck, signal, attempt);
    } catch (error) {
      if (!attempt.signingStarted) throw unsignedSigningFailure(error);
      throw error;
    }
  }
  async signPermitAuthorization(key: ManagedKey, authorization: UptoAuthorization,
    finalCheck: (value: Readonly<ExactAuthorization>) => void, signal?: AbortSignal): Promise<string> {
    const attempt = { signingStarted: false };
    try { return await this.signChecked(key, authorization, finalCheck, signal, attempt, true); }
    catch (error) { if (!attempt.signingStarted) throw unsignedSigningFailure(error); throw error; }
  }
  private async signChecked(
    keyInput: ManagedKey,
    authorizationInput: ExactAuthorization,
    finalCheck: (authorization: Readonly<ExactAuthorization>) => void,
    signal: AbortSignal | undefined,
    attempt: { signingStarted: boolean },
    permit = false,
  ): Promise<string> {
    const key = Object.freeze({ ...keyInput });
    requireWallet(key.kind !== "general_source", "GENERAL_PAYMENT_OWNER_REQUIRED", "This source requires the fixed protected payment owner.");
    const authorization = Object.freeze({ ...authorizationInput });
    const config = networkConfig(key.network);
    requireWallet(
      !types.isAsyncFunction(finalCheck),
      "INVALID_FINAL_CHECK",
      "The final signing check must be synchronous.",
    );
    requireWallet(
      authorization.network === key.network,
      "PAYMENT_NETWORK_MISMATCH",
      "The key and authorization networks differ.",
    );
    requireWallet(
      authorization.asset.toLowerCase() === config.asset &&
        authorization.payer.toLowerCase() === key.address.toLowerCase() &&
        /^0x[0-9a-fA-F]{40}$/.test(authorization.payTo) &&
        /^0x[0-9a-fA-F]{64}$/.test(authorization.nonce),
      "PERMIT_MISMATCH",
      "Authorization identity does not match the wallet.",
    );
    positiveAtomic(authorization.amountAtomic);
    timestamp(authorization.validAfter);
    timestamp(authorization.validBefore);
    const password = await this.password(key);
    const material = await this.task<{ privateKey: string; address: string }>(
      { operation: "load", password, keystore: key.keystore },
      signal,
    );
    requireWallet(
      !signal?.aborted && material.address.toLowerCase() === key.address.toLowerCase(),
      "WALLET_OPERATION_ABORTED",
      "Signing was canceled or the wallet identity changed.",
    );
    const wallet = new Wallet(material.privateKey);
    requireWallet(
      wallet.address.toLowerCase() === key.address.toLowerCase(),
      "PERMIT_MISMATCH",
      "The keystore address changed.",
    );
    const message = {
      from: authorization.payer,
      to: authorization.payTo,
      value: authorization.amountAtomic,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce: authorization.nonce,
    };
    requireWallet(!permit || authorization.upto, "PERMIT_MISMATCH", "Only a fixed upto intent may sign a permit.");
    const typed = authorization.upto ? (permit ? usdcPermitTypedData(authorization as UptoAuthorization) : uptoTypedData(authorization as UptoAuthorization)) : {
      domain: { name: config.domainName, version: config.domainVersion, chainId: config.chainId, verifyingContract: config.asset }, types: TYPES, message,
    };
    const hash = TypedDataEncoder.hash(typed.domain, typed.types, typed.message);
    const checked: unknown = finalCheck(authorization);
    if (checked instanceof Promise) void checked.catch(() => {});
    requireWallet(
      checked === undefined,
      "INVALID_FINAL_CHECK",
      "The final signing check must complete synchronously.",
    );
    requireWallet(
      !signal?.aborted,
      "WALLET_OPERATION_ABORTED",
      "Signing was canceled during the final check.",
    );
    const signer = new SigningKey(material.privateKey);
    attempt.signingStarted = true;
    return signer.sign(hash).serialized;
  }
  async protectSignature(intentId: string, signature: string): Promise<string> {
    requireWallet(
      /^[0-9a-f-]{36}$/.test(intentId) && /^0x[0-9a-f]{130}$/i.test(signature),
      "PERMIT_MISMATCH",
      "The payment signature is invalid.",
    );
    const ref = "signature:" + intentId;
    const bytes = Buffer.from(signature);
    try {
      await this.protection.put(ref, bytes);
    } finally {
      bytes.fill(0);
    }
    return ref;
  }
}
