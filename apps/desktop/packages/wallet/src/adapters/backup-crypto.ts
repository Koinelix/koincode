import { randomBytes } from "node:crypto";
import { CompactEncrypt, compactDecrypt } from "jose";
import { decryptKeystoreJson, encryptKeystoreJson, Wallet } from "ethers";
import { requireWallet } from "../domain/errors.js";
import { withBackupCrypto } from "./backupKeyWrap.js";

import type { BackupMetadata } from "../app/ports.js";
export type { BackupMetadata } from "../app/ports.js";
export type BackupJob =
  | { operation: "encrypt"; privateKey: string; metadata: BackupMetadata; password: string }
  | { operation: "decrypt"; backup: string; password: string };
const MAX_BACKUP = 16 * 1024 * 1024;
const HEADER_KEYS = ["alg", "enc", "typ", "p2c", "p2s"];
function invalid(condition: unknown): asserts condition {
  requireWallet(
    condition,
    "BACKUP_INVALID",
    "The wallet backup is invalid or exceeds resource limits.",
  );
}
function canonicalJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  invalid(JSON.stringify(parsed) === text);
  return parsed;
}
function passwordBytes(password: string): Uint8Array {
  invalid(typeof password === "string");
  const normalized = password.normalize("NFKC");
  const bytes = Buffer.from(normalized, "utf8");
  invalid(Array.from(normalized).length >= 16 && bytes.length <= 256);
  return bytes;
}
function metadataValid(value: BackupMetadata): void {
  invalid(value && /^0x[0-9a-fA-F]{40}$/.test(value.address));
  invalid(value.network === "eip155:84532" || value.network === "eip155:8453");
  const asset =
    value.network === "eip155:84532"
      ? "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
      : "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  invalid(value.asset.toLowerCase() === asset);
  invalid(
    Number.isSafeInteger(value.baselineBlock) &&
      value.baselineBlock >= 0 &&
      /^0x[0-9a-fA-F]{64}$/.test(value.baselineHash),
  );
  invalid(typeof value.history === "string" && Buffer.byteLength(value.history) <= 8 * 1024 * 1024);
  canonicalJson(value.history);
  invalid(
    Object.keys(value).sort().join() ===
      ["address", "network", "asset", "baselineBlock", "baselineHash", "history"].sort().join(),
  );
}
function rejectCaseAmbiguity(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) {
    const keys = Object.keys(value).map((key) => key.toLowerCase());
    invalid(new Set(keys).size === keys.length);
  }
  for (const child of Object.values(value)) rejectCaseAmbiguity(child);
}
export function validateKeystoreForRestore(text: string): void {
  invalid(typeof text === "string" && Buffer.byteLength(text) <= 8192);
  const data = canonicalJson(text) as Record<string, any>;
  rejectCaseAmbiguity(data);
  invalid(!(data.Crypto && data.crypto));
  const crypto = data.Crypto ?? data.crypto;
  invalid(data.version === 3 && crypto?.cipher === "aes-128-ctr" && crypto.kdf === "scrypt");
  const params = crypto.kdfparams;
  invalid(params?.n === 131072 && params.r === 8 && params.p === 1 && params.dklen === 32);
  invalid(/^[0-9a-f]{64}$/i.test(params.salt) && /^[0-9a-f]{32}$/i.test(crypto.cipherparams?.iv));
  invalid(/^[0-9a-f]{64}$/i.test(crypto.ciphertext) && /^[0-9a-f]{64}$/i.test(crypto.mac));
}
export async function executeBackupJob(job: BackupJob): Promise<unknown> {
  return withBackupCrypto(() => executeBackup(job));
}
async function executeBackup(job: BackupJob): Promise<unknown> {
  const password = passwordBytes(job.password);
  try {
    if (job.operation === "encrypt") {
      metadataValid(job.metadata);
      const wallet = new Wallet(job.privateKey);
      invalid(wallet.address.toLowerCase() === job.metadata.address.toLowerCase());
      const keystore = await encryptKeystoreJson(
        { address: wallet.address, privateKey: wallet.privateKey },
        password,
        { scrypt: { N: 131072, r: 8, p: 1 } },
      );
      const payload = Buffer.from(
        JSON.stringify({
          format: "koincode-wallet-backup",
          version: 1,
          metadata: job.metadata,
          keystore,
        }),
      );
      try {
        invalid(payload.length <= 12 * 1024 * 1024);
        const backup = await new CompactEncrypt(payload)
          .setProtectedHeader({
            alg: "PBES2-HS512+A256KW",
            enc: "A256GCM",
            typ: "koincode-wallet-backup+jwe",
          })
          .setKeyManagementParameters({ p2c: 600000, p2s: randomBytes(16) })
          .encrypt(password);
        invalid(Buffer.byteLength(backup) <= MAX_BACKUP);
        return { backup };
      } finally {
        payload.fill(0);
      }
    }
    invalid(typeof job.backup === "string" && Buffer.byteLength(job.backup) <= MAX_BACKUP);
    const segments = job.backup.split(".");
    invalid(
      segments.length === 5 &&
        segments.every((segment) => /^[A-Za-z0-9_-]+$/.test(segment)) &&
        segments[0]!.length <= 1400,
    );
    const header = canonicalJson(Buffer.from(segments[0]!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    invalid(Object.keys(header).every((key) => HEADER_KEYS.includes(key)));
    invalid(
      header.alg === "PBES2-HS512+A256KW" &&
        header.enc === "A256GCM" &&
        header.typ === "koincode-wallet-backup+jwe" &&
        header.p2c === 600000,
    );
    invalid(
      typeof header.p2s === "string" &&
        /^[A-Za-z0-9_-]+$/.test(header.p2s) &&
        Buffer.from(header.p2s, "base64url").length === 16,
    );
    const { plaintext } = await compactDecrypt(job.backup, password, {
      keyManagementAlgorithms: ["PBES2-HS512+A256KW"],
      contentEncryptionAlgorithms: ["A256GCM"],
      maxPBES2Count: 600000,
    });
    try {
      invalid(plaintext.length <= 12 * 1024 * 1024);
      const payload = canonicalJson(Buffer.from(plaintext).toString("utf8")) as {
        format: string;
        version: number;
        metadata: BackupMetadata;
        keystore: string;
      };
      invalid(
        Object.keys(payload).sort().join() ===
          ["format", "version", "metadata", "keystore"].sort().join(),
      );
      invalid(payload.format === "koincode-wallet-backup" && payload.version === 1);
      metadataValid(payload.metadata);
      validateKeystoreForRestore(payload.keystore);
      const account = await decryptKeystoreJson(payload.keystore, password);
      const address = new Wallet(account.privateKey).address;
      invalid(
        address.toLowerCase() === account.address.toLowerCase() &&
          address.toLowerCase() === payload.metadata.address.toLowerCase(),
      );
      return {
        privateKey: account.privateKey,
        address,
        metadata: payload.metadata,
        keystore: payload.keystore,
      };
    } finally {
      plaintext.fill(0);
    }
  } finally {
    password.fill(0);
  }
}

export { executeBackupJob as executeJob };
