import { parentPort, workerData } from "node:worker_threads";

try {
  const module = workerData.moduleUrl.endsWith(".ts")
    ? await (await import("tsx/esm/api")).tsImport(workerData.moduleUrl, import.meta.url)
    : await import(workerData.moduleUrl);
  const result = await module.executeJob(workerData.job);
  parentPort.postMessage({ ok: true, result });
} catch {
  parentPort.postMessage({ ok: false });
}
