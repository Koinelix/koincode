import { rm, stat } from "node:fs/promises";
import process from "node:process";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSpawnRuntimeOptions } from "../../../scripts/spawn-command.mjs";

export function resolveDesktopBuildCwd() {
  // tsup and Vite entrypoints are relative to the desktop package root.
  // Running from scripts would resolve src/main/index.ts under the wrong directory on Windows CI.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export async function verifyDesktopProductionOutput({ cwd = resolveDesktopBuildCwd() } = {}) {
  // Development clears out; refuse incomplete production output before packaging.
  for (const entry of [
    "out/main/index.js",
    "out/main/inspectResponseJob.js",
    "out/main/response-worker.mjs",
    "out/host/index.js",
    "out/preload/index.cjs",
    "out/scheduler/index.js",
    "out/wallet/index.js",
    "out/wallet/keyCrypto.js",
    "out/wallet/secret-crypto.js",
    "out/wallet/exact-crypto.js",
    "out/wallet/general-exact-worker.mjs",
    "out/wallet/general-secret-worker.mjs",
    "out/wallet/backup-crypto.js",
    "out/wallet/crypto-worker.mjs",
    "out/wallet/inspectResponseJob.js",
    "out/wallet/response-worker.mjs",
    "out/renderer/index.html",
    "out/general-wallet/index.js",
    "out/general-wallet/secret-crypto.js",
    "out/general-wallet/backup-crypto.js",
    "out/general-wallet/archive-crypto.js",
    "out/general-wallet/crypto-tasks.js",
    "out/general-wallet/general-secret-worker.mjs",
    "out/general-wallet/general-exact-worker.mjs",
    "out/general-wallet/exact-crypto.js",
    "out/general-wallet/exact-worker.js",
    "out/general-wallet/setup-window.js",
    "out/general-wallet/setup-ui/index.html",
    "out/general-wallet/setup-ui/setup.js",
    "out/general-wallet/setup-ui/accounts.js",
    "out/general-wallet/setup-ui/history.js",
    "out/general-wallet/setup-ui/manual.js",
    "out/general-wallet/setup-ui/backup.js", "out/general-wallet/setup-ui/restore.js",
    "out/general-wallet/setup-ui/style.css",
    "out/general-wallet/setup-ui/preload.cjs",
    "out/general-wallet/setup-ui/en-US.json",
    "out/general-wallet/setup-ui/zh-CN.json",
    "out/general-wallet/transfer-confirmation-window.js",
    "out/general-wallet/transfer-confirmation-ui/index.html",
    "out/general-wallet/transfer-confirmation-ui/confirmation.js",
    "out/general-wallet/transfer-confirmation-ui/style.css",
    "out/general-wallet/transfer-confirmation-ui/preload.cjs",
    "out/general-wallet/transfer-confirmation-ui/en-US.json",
    "out/general-wallet/transfer-confirmation-ui/zh-CN.json",
    "out/renderer/wallet/payment.html",
    "out/renderer/wallet/payment-preload.cjs",
    "out/renderer/wallet/payment-confirmation.js",
    "out/renderer/wallet/payments.js",
    "out/renderer/wallet/style.css",
  ]) {
    const file = await stat(resolve(cwd, entry)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!file?.isFile() || file.size === 0)
      throw new Error(
        `Missing or invalid desktop production output: ${entry}; run a production build`,
      );
  }
}

export function resolveDesktopProductionCleanPaths(cwd) {
  return [
    resolve(cwd, "out/main"),
    resolve(cwd, "out/host"),
    resolve(cwd, "out/preload"),
    resolve(cwd, "out/wallet"),
    resolve(cwd, "out/general-wallet"),
    resolve(cwd, "out/renderer"),
    resolve(cwd, "out/.main-build-ready"),
    resolve(cwd, "out/.host-build-ready"),
    resolve(cwd, "out/.preload-build-ready"),
    resolve(cwd, "out/.wallet-build-ready"),
  ];
}

export async function cleanDesktopProductionOutput({ cwd }) {
  if (process.env.FCODE_E2E_KEEP_BUILD_CACHE === "1") {
    console.log("[build] FCODE_E2E_KEEP_BUILD_CACHE=1, skipping clean");
    return;
  }
  // tsup does not remove stale development or previous production chunks.
  // Packaging out/**/* would otherwise retain unminified JavaScript and source-map references.
  await Promise.all(
    resolveDesktopProductionCleanPaths(cwd).map((targetPath) =>
      rm(targetPath, { force: true, recursive: true }),
    ),
  );
}

export function createDesktopProductionBuildPlan({ cwd, baseEnv = process.env }) {
  const env = {
    ...baseEnv,
    NODE_ENV: "production",
  };

  return [
    {
      label: "desktop production bundles",
      parallel: [
        {
          command: "pnpm",
          args: ["exec", "tsup"],
          cwd,
          env,
        },
        {
          command: "pnpm",
          args: ["exec", "vite", "build"],
          cwd,
          env,
        },
      ],
    },
  ];
}

function runCommandAsync(step) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      env: step.env,
      stdio: "inherit",
      ...resolveSpawnRuntimeOptions(step.command),
    });

    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }

      const reason = signal ? `signal ${signal}` : `code ${code}`;
      rejectRun(new Error(`${step.command} ${step.args.join(" ")} failed with ${reason}`));
    });
  });
}

export async function runDesktopProductionBuild({ cwd = resolveDesktopBuildCwd() } = {}) {
  await cleanDesktopProductionOutput({ cwd });
  for (const step of createDesktopProductionBuildPlan({ cwd })) {
    if (step.parallel) {
      // tsup and Vite write separate main/preload/host and renderer directories.
      // Build them concurrently with consistent cwd and environment on every platform.
      await Promise.all(step.parallel.map(runCommandAsync));
      continue;
    }

    await runCommandAsync(step);
  }
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  await runDesktopProductionBuild();
}
