import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve("out/wallet");
await mkdir(output, { recursive: true });
await copyFile(
  resolve("../wallet/src/adapters/crypto-worker.mjs"),
  resolve(output, "crypto-worker.mjs"),
);
await copyFile(
  resolve("../wallet/src/adapters/response-worker.mjs"),
  resolve(output, "response-worker.mjs"),
);
await copyFile(resolve("../wallet/src/adapters/general-secret-worker.mjs"), resolve(output, "general-secret-worker.mjs"));
await copyFile(resolve("../wallet/src/adapters/general-exact-worker.mjs"), resolve(output, "general-exact-worker.mjs"));
await writeFile(resolve("out/.wallet-build-ready"), `${new Date().toISOString()}\n`, "utf8");
