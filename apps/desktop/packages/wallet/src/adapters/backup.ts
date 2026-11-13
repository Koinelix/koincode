import { runCryptoTask } from "./cryptoTask.js";
import { WalletError } from "../domain/errors.js";
import type { BackupJob, BackupMetadata } from "./backup-crypto.js";
export type { BackupMetadata } from "./backup-crypto.js";
export interface RestoredBackup {
  privateKey: string;
  address: string;
  metadata: BackupMetadata;
  keystore: string;
}
export function runBackupJob<T extends { backup: string } | RestoredBackup>(
  job: BackupJob,
  signal?: AbortSignal,
): Promise<T> {
  const commonValid =
    job && typeof job.password === "string" && Buffer.byteLength(job.password) <= 1024;
  const inputValid =
    commonValid &&
    (job.operation === "decrypt"
      ? typeof job.backup === "string" &&
        Buffer.byteLength(job.backup) <= 16 * 1024 * 1024 &&
        Object.keys(job).sort().join() === "backup,operation,password"
      : job.operation === "encrypt" &&
        /^0x[0-9a-fA-F]{64}$/.test(job.privateKey) &&
        job.metadata &&
        typeof job.metadata.history === "string" &&
        Buffer.byteLength(job.metadata.history) <= 8 * 1024 * 1024 &&
        Object.keys(job.metadata).sort().join() ===
          "address,asset,baselineBlock,baselineHash,history,network" &&
        Object.keys(job).sort().join() === "metadata,operation,password,privateKey");
  if (!inputValid)
    return Promise.reject(
      new WalletError("BACKUP_INVALID", "The wallet backup input exceeds its resource bounds."),
    );
  if (signal?.aborted)
    return Promise.reject(
      new WalletError("WALLET_OPERATION_ABORTED", "The wallet operation was canceled."),
    );
  const moduleUrl = new URL(
    import.meta.url.endsWith(".ts") ? "./backup-crypto.ts" : "./backup-crypto.js",
    import.meta.url,
  ).href;
  return runCryptoTask<T>(moduleUrl, job, signal);
}
