import { parentPort, workerData } from "node:worker_threads";

const permitted = new Set(["INVALID_MNEMONIC", "INVALID_PRIVATE_KEY", "GENERAL_SECRET_INVALID", "GENERAL_BACKUP_INVALID", "GENERAL_HISTORY_ARCHIVE_INVALID"]);
try {
  const module = workerData.moduleUrl.endsWith(".ts")
    ? await (await import("tsx/esm/api")).tsImport(workerData.moduleUrl, import.meta.url)
    : await import(workerData.moduleUrl);
  const handlers = { backup: module.executeGeneralBackupJob, archive: module.executeGeneralHistoryArchiveJob, secret: module.executeGeneralSecretJob };
  const result = await handlers[workerData.kind](workerData.job);
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  const code = error && typeof error === "object" && permitted.has(error.code) ? error.code : "GENERAL_SECRET_INVALID";
  parentPort.postMessage({ ok: false, code });
} finally {
  if (workerData.job?.key instanceof Uint8Array) workerData.job.key.fill(0);
  if ((workerData.kind === "backup" || workerData.kind === "archive") && workerData.job) {
    if (workerData.kind === "backup") workerData.job.password = "";
    const keys = workerData.job.payload?.wrappingKeys;
    if (Array.isArray(keys)) for (const item of keys) if (item && typeof item === "object") item.key = "";
  }
}
