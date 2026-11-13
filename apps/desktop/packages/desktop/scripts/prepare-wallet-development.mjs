import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
// Rebuild freely into v2; historical readers in the parent directory are retained.
execFileSync(process.execPath, [resolve(root, "../wallet/scripts/build-native.mjs"), "--user-store-v2"], {
  cwd: root, env: process.env, stdio: "inherit", timeout: 120_000,
});
const tsup = resolve(dirname(require.resolve("tsup/package.json")), "dist/cli-default.js");
execFileSync(process.execPath, [tsup, "--config", "tsup.wallet.config.ts"], {
  cwd: root, env: process.env, stdio: "inherit", timeout: 120_000,
});
for (const name of ["index.js", "exact-crypto.js", "general-exact-worker.mjs", "secret-crypto.js", "general-secret-worker.mjs", "keyCrypto.js", "backup-crypto.js", "crypto-worker.mjs", "inspectResponseJob.js", "response-worker.mjs"]) {
  const item = statSync(resolve(root, "out/wallet", name));
  if (!item.isFile() || item.size === 0) throw new Error("Wallet development assets are incomplete.");
}
