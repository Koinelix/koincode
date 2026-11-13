import { Worker } from "node:worker_threads";
import { WalletError } from "../domain/errors.js";
import type { GeneralSecretJob } from "./generalSecretCrypto.js";
import { consumeGeneralSignerPermit } from "./generalSigningCapability.js";
import { assertGeneralBackupJobInput, type GeneralBackupJob, type GeneralBackupPreviewJob, type GeneralBackupCryptoJob } from "./generalBackupEnvelope.js";
import { assertGeneralHistoryArchiveJob, type GeneralHistoryArchiveJob } from "./generalHistoryArchiveEnvelope.js";
import { validateGeneralBackupPreview, type GeneralBackupPreview } from "./generalBackupPreview.js";

import { generalCryptoWorkerAvailable, reserveGeneralCryptoWorker } from "./generalCryptoCapacity.js";
const allowedErrors = new Set(["INVALID_MNEMONIC", "INVALID_PRIVATE_KEY", "GENERAL_SECRET_INVALID", "GENERAL_BACKUP_INVALID", "GENERAL_HISTORY_ARCHIVE_INVALID"]);
const cryptoModules = { secret: ["./generalSecretCrypto.ts", "./secret-crypto.js"],
  backup: ["./generalBackupCrypto.ts", "./backup-crypto.js"], archive: ["./generalHistoryArchiveCrypto.ts", "./archive-crypto.js"] } as const;

/** Only the isolated general-wallet process may own this pool; no legacy worker is used. */
export function runGeneralCryptoTask<T>(job: GeneralSecretJob, signal?: AbortSignal): Promise<T> {
  if (job?.operation === "sign_transaction") return Promise.reject(new WalletError("SIGNING_CONTINUITY_UNKNOWN", "A protected signing capability is required."));
  return runTask(job, signal);
}

/** Secret-bearing results stay inside the protected owner; this is absent from all renderer and payment ports. */
export function runGeneralBackupTask<T>(job: GeneralBackupJob, signal?: AbortSignal): Promise<T> {
  return runTask(job, signal, "backup");
}

/** Only the trusted bootstrap owner may receive this history; this primitive establishes no native authority. */
export async function runGeneralBackupPreviewTask(job: GeneralBackupPreviewJob, signal?: AbortSignal): Promise<GeneralBackupPreview> {
  if (job?.operation !== "preview_backup") throw new WalletError("GENERAL_BACKUP_INVALID", "The general wallet backup could not be verified.");
  const result = await runTask<unknown>(job, signal, "backup");
  const preview = validateGeneralBackupPreview(result);
  if (signal?.aborted) throw new WalletError("GENERAL_OPERATION_CANCELED", "The wallet operation was canceled.");
  return preview;
}

/** Shares backup admission and limits; no separate archive pool or legacy worker is created. */
export function runGeneralHistoryArchiveTask<T>(job: GeneralHistoryArchiveJob, signal?: AbortSignal): Promise<T> {
  return runTask(job, signal, "archive");
}

/** Signing is available only after the independent journal consumes an exact one-use approval. */
export function runGeneralSignTask<T>(job: Extract<GeneralSecretJob, { operation: "sign_transaction" }>, permit: object, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new WalletError("GENERAL_OPERATION_CANCELED", "The wallet operation was canceled."));
  if (!generalCryptoWorkerAvailable()) return Promise.reject(new WalletError("GENERAL_OPERATION_BUSY", "General wallet workers are busy."));
  try { consumeGeneralSignerPermit(permit, job.preview, job.riskId); }
  catch (error) { return Promise.reject(error); }
  return runTask(job, signal);
}

function runTask<T>(job: GeneralSecretJob | GeneralBackupCryptoJob | GeneralHistoryArchiveJob, signal?: AbortSignal, kind: keyof typeof cryptoModules = "secret"): Promise<T> {
  if (signal?.aborted) return Promise.reject(new WalletError("GENERAL_OPERATION_CANCELED", "The wallet operation was canceled."));
  if (kind === "backup") {
    try { assertGeneralBackupJobInput(job as GeneralBackupCryptoJob); } catch (error) { return Promise.reject(error); }
  } else if (kind === "archive") {
    try { assertGeneralHistoryArchiveJob(job as GeneralHistoryArchiveJob); } catch (error) { return Promise.reject(error); }
  } else if (!job || typeof job !== "object" || !("key" in job) || !(job.key instanceof Uint8Array) || job.key.byteLength !== 32 ||
      !("ownerId" in job) || typeof job.ownerId !== "string" || job.ownerId.length > 80 || !("keySourceId" in job) || typeof job.keySourceId !== "string" || job.keySourceId.length > 80 ||
      ("phrase" in job && (typeof job.phrase !== "string" || Buffer.byteLength(job.phrase) > 1024)) ||
      ("privateKey" in job && (typeof job.privateKey !== "string" || Buffer.byteLength(job.privateKey) > 256)) ||
      ("envelope" in job && (typeof job.envelope !== "string" || Buffer.byteLength(job.envelope) > 8192)) ||
      ("protectedMaterial" in job && (typeof job.protectedMaterial !== "string" || Buffer.byteLength(job.protectedMaterial) > 8192)) ||
      (job.operation === "sign_transaction" && (typeof job.protectedMaterial !== "string" || Buffer.byteLength(job.protectedMaterial) > 8192 ||
        !job.preview || typeof job.preview.unsignedTransaction !== "string" || job.preview.unsignedTransaction.length > 8192)) ||
      (job.operation === "verify" && (!Array.isArray(job.positions) || job.positions.length !== 3 || !Array.isArray(job.words) ||
        job.words.length !== 3 || job.words.some((word) => typeof word !== "string" || Buffer.byteLength(word) > 64))))
    return Promise.reject(new WalletError("GENERAL_SECRET_INVALID", "Invalid protected wallet material."));
  const backupClass = kind !== "secret";
  let release: () => void;
  try { release = reserveGeneralCryptoWorker(backupClass); } catch (error) { return Promise.reject(error); }
  return new Promise<T>((resolve, reject) => {
    let worker: Worker;
    try {
      const [source, built] = cryptoModules[kind];
      const moduleUrl = new URL(import.meta.url.endsWith(".ts") ? source : built, import.meta.url).href;
      worker = new Worker(new URL("./general-secret-worker.mjs", import.meta.url), {
        workerData: { moduleUrl, job, kind }, env: {}, execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      });
    } catch {
      release();
      reject(new WalletError("GENERAL_CRYPTO_FAILED", "The wallet worker could not start."));
      return;
    }
    let settled = false;
    const finish = (error?: WalletError, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // Do not release capacity or return a result until this worker has actually stopped.
      void worker.terminate().then(() => {
        release();
        if (error) reject(error); else resolve(value as T);
      }, () => reject(new WalletError("GENERAL_CRYPTO_FAILED", "The wallet worker could not be stopped.")));
    };
    const abort = () => finish(new WalletError("GENERAL_OPERATION_CANCELED", "The wallet operation was canceled."));
    const timer = setTimeout(() => finish(new WalletError("GENERAL_OPERATION_TIMEOUT", "The wallet operation timed out.")), backupClass ? 60000 : 30000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    worker.once("message", (message: unknown) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        finish(new WalletError("GENERAL_CRYPTO_FAILED", "The wallet worker returned an invalid result.")); return;
      }
      const reply = message as Record<string, unknown>;
      if (reply.ok === true && Object.keys(reply).sort().join() === "ok,result") finish(undefined, reply.result as T);
      else {
        const code = typeof reply.code === "string" && allowedErrors.has(reply.code) ? reply.code : "GENERAL_CRYPTO_FAILED";
        finish(new WalletError(code, "The protected wallet material could not be processed."));
      }
    });
    worker.once("error", () => finish(new WalletError("GENERAL_CRYPTO_FAILED", "The wallet worker failed.")));
    worker.once("exit", () => { if (!settled) finish(new WalletError("GENERAL_CRYPTO_FAILED", "The wallet worker stopped.")); });
  });
}
