import { parentPort, workerData } from "node:worker_threads";
let signer, consumed = false;
const fail = () => { parentPort.postMessage({ kind: "failed" }); signer?.close(); parentPort.close(); };
try {
  const module = workerData.moduleUrl.endsWith(".ts") ? await (await import("tsx/esm/api")).tsImport(workerData.moduleUrl, import.meta.url) : await import(workerData.moduleUrl);
  signer = await module.prepareGeneralExactCrypto(workerData.input);
  parentPort.on("message", async (message) => {
    if (consumed || !message || Object.keys(message).sort().join() !== "command,digest" || message.command !== "commit" || message.digest !== signer.digest) { consumed = true; fail(); return; }
    consumed = true;
    try { parentPort.postMessage({ kind: "signed", digest: signer.digest, signature: await signer.commit(message.digest) }); }
    catch { fail(); }
    finally { signer.close(); parentPort.close(); }
  });
  parentPort.postMessage({ kind: "prepared", digest: signer.digest });
} catch { fail(); }
finally { if (workerData.input?.key instanceof Uint8Array) workerData.input.key.fill(0); }
