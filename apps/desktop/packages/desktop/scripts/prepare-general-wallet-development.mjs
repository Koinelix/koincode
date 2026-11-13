import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const tsup = resolve(dirname(require.resolve("tsup/package.json")), "dist/cli-default.js");
execFileSync(process.execPath, [tsup, "--config", "tsup.general-wallet.config.ts"], {
  cwd: root, env: process.env, stdio: "inherit", timeout: 120_000,
});
for (const name of ["index.js", "setup-window.js", "secret-crypto.js", "backup-crypto.js", "archive-crypto.js", "crypto-tasks.js", "general-secret-worker.mjs",
  "setup-ui/index.html", "setup-ui/setup.js", "setup-ui/accounts.js", "setup-ui/history.js", "setup-ui/manual.js", "setup-ui/backup.js", "setup-ui/restore.js", "setup-ui/style.css", "setup-ui/preload.cjs", "setup-ui/en-US.json", "setup-ui/zh-CN.json",
  "transfer-confirmation-window.js", "transfer-confirmation-ui/index.html", "transfer-confirmation-ui/confirmation.js", "transfer-confirmation-ui/style.css",
  "transfer-confirmation-ui/preload.cjs", "transfer-confirmation-ui/en-US.json", "transfer-confirmation-ui/zh-CN.json"]) {
  const item = statSync(resolve(root, "out/general-wallet", name));
  if (!item.isFile() || item.size === 0) throw new Error("General wallet development assets are incomplete.");
}
