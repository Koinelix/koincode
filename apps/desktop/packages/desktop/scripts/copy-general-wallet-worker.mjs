import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve("out/general-wallet");
await mkdir(output, { recursive: true });
await copyFile(resolve("../wallet/src/adapters/general-secret-worker.mjs"), resolve(output, "general-secret-worker.mjs"));
await copyFile(resolve("../wallet/src/adapters/general-exact-worker.mjs"), resolve(output, "general-exact-worker.mjs"));

// Ship the sensitive host resources independently of the legacy wallet UI.
const ui = resolve(output, "setup-ui");
await mkdir(ui, { recursive: true });
for (const name of ["index.html", "setup.js", "accounts.js", "history.js", "manual.js", "backup.js", "restore.js", "style.css", "preload.cjs", "en-US.json", "zh-CN.json"])
  await copyFile(resolve("src/renderer/public/general-wallet-setup", name), resolve(ui, name));

const confirmation = resolve(output, "transfer-confirmation-ui");
await mkdir(confirmation, { recursive: true });
for (const name of ["index.html", "confirmation.js", "style.css", "preload.cjs", "en-US.json", "zh-CN.json"])
  await copyFile(resolve("src/renderer/public/general-transfer-confirmation", name), resolve(confirmation, name));
