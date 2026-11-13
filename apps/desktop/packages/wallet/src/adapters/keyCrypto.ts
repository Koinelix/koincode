import { signAllowance } from "../domain/allowanceTransaction.js";
import { openSync, closeSync, fstatSync, lstatSync, readSync, constants } from "node:fs";
import { Wallet, encryptKeystoreJson, decryptKeystoreJson } from "ethers";
import { requireWallet } from "../domain/errors.js";
import { executeBackupJob, validateKeystoreForRestore } from "./backup-crypto.js";
import type { BackupMetadata } from "../app/ports.js";
export type KeyJob =
  | { operation: "create"; password: string }
  | { operation: "import_test"; password: string; path: string }
  | { operation: "allowance"; tx: import("../domain/allowanceTransaction.js").AllowanceTransaction; password: string; keystore: string }
  | { operation: "load"; password: string; keystore: string }
  | {
      operation: "backup";
      password: string;
      keystore: string;
      metadata: BackupMetadata;
      userPassword: string;
    }
  | { operation: "restore"; password: string; backup: string; userPassword: string };
async function encrypted(privateKey: string, password: string) {
  const wallet = new Wallet(privateKey);
  const keystore = await encryptKeystoreJson(
    { address: wallet.address, privateKey: wallet.privateKey },
    password,
    { scrypt: { N: 131072, r: 8, p: 1 } },
  );
  return { address: wallet.address.toLowerCase(), keystore };
}
function isolatedTestKey(path: string): string {
  const before = lstatSync(path);
  requireWallet(
    before.isFile() && !before.isSymbolicLink(),
    "TEST_WALLET_INVALID",
    "The isolated wallet input must be a regular file.",
  );
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const bytes = Buffer.alloc(4097);
  try {
    const stat = fstatSync(descriptor);
    requireWallet(
      stat.isFile() &&
        (stat.mode & 0o077) === 0 &&
        stat.size <= 4096 &&
        (typeof process.getuid !== "function" || stat.uid === process.getuid()),
      "TEST_WALLET_INVALID",
      "The isolated test wallet file is not private.",
    );
    let length = 0;
    for (;;) {
      const read = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!read) break;
      length += read;
      requireWallet(
        length <= 4096,
        "TEST_WALLET_INVALID",
        "The isolated wallet exceeds its bounds.",
      );
    }
    const input = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    requireWallet(
      input.network === "eip155:84532" &&
        typeof input.private_key === "string" &&
        new Wallet(input.private_key).address.toLowerCase() === String(input.payer).toLowerCase(),
      "TEST_WALLET_INVALID",
      "The isolated wallet is not a matching Base Sepolia key.",
    );
    return input.private_key;
  } finally {
    bytes.fill(0);
    closeSync(descriptor);
  }
}
export async function executeJob(job: KeyJob): Promise<unknown> {
  requireWallet(
    /^[0-9a-f]{64}$/.test(job.password),
    "CRYPTO_INPUT_INVALID",
    "A random protected keystore password is required.",
  );
  if (job.operation === "create") return encrypted(Wallet.createRandom().privateKey, job.password);
  if (job.operation === "import_test") return encrypted(isolatedTestKey(job.path), job.password);
  if (job.operation === "restore") {
    const result = (await executeBackupJob({
      operation: "decrypt",
      backup: job.backup,
      password: job.userPassword,
    })) as { privateKey: string; metadata: BackupMetadata };
    return { ...(await encrypted(result.privateKey, job.password)), metadata: result.metadata };
  }
  validateKeystoreForRestore(job.keystore);
  const account = await decryptKeystoreJson(job.keystore, job.password);
  if (job.operation === "allowance") return signAllowance(new Wallet(account.privateKey), job.tx);
  if (job.operation === "load")
    return { privateKey: account.privateKey, address: account.address.toLowerCase() };
  const result = await executeBackupJob({
    operation: "encrypt",
    privateKey: account.privateKey,
    metadata: job.metadata,
    password: job.userPassword,
  });
  return result;
}
