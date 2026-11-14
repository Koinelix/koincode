#!/usr/bin/env node

// Agent runtime assets for the packaged desktop app: put the agent's JS bundle (fcode.cjs) into
// bundled-agents/<platform>/glm. The app's built-in Electron Node runtime (ELECTRON_RUN_AS_NODE)
// executes it, replacing the standalone Node binary that used to ship with the package.
//
// Why:
// - The agent has no native NAPI addons (ripgrep is WASM, the rest is pure JS), so it runs directly on Electron's Node.
// - Electron 41 embeds Node 24.x, which matches the target runtime of fcode-cli.
// - Per-platform size drops from ~180MB to ~16MB, and the same JS works on every platform.
// - The app-server command path never loads @fcode/tui, so the TUI is naturally left out here.
//
// Remote targets (SSH/WSL/Docker) have no Electron and still use the native binaries from prepare:remote-assets; the two paths are independent.

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { stageAgentBundle } from "./stage-agent-bundle.mjs";
import { stageBundledSkillPack } from "./stage-koinelix-skill.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const cliBundlePath = resolve(repoRoot, "apps/kcode-cli/packages/cli/dist/fcode.cjs");
const adaptersRoot = resolve(repoRoot, "apps/kcode-cli/packages/adapters");
const pnpmRunEnv = {
  ...process.env,
  // pnpm 11 may auto-install in the nested CLI workspace before running scripts.
  // The nested workspace cannot resolve the outer workspace's @fcode/shared.
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
};
const BROWSER_USE_PLUGIN_PACKAGE_NAME = "@fcode/browser-use-plugin";

// Platform directory naming: darwin/win32/linux + x64/arm64.
// FCODE_TARGET_OS / FCODE_TARGET_ARCH override it (injected by CI when cross-packaging).
function normalizePlatform(raw) {
  switch (raw) {
    case "mac":
    case "macos":
    case "darwin":
    case "osx":
      return "darwin";
    case "win":
    case "windows":
    case "win32":
      return "win32";
    case "linux":
      return "linux";
    default:
      return raw;
  }
}

function normalizeArch(raw) {
  switch (raw) {
    case "x86_64":
    case "x64":
    case "amd64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return raw;
  }
}

const platform = normalizePlatform(process.env.FCODE_TARGET_OS || "") || process.platform;
const arch = normalizeArch(process.env.FCODE_TARGET_ARCH || "") || process.arch;
const platformKey = `${platform}-${arch}`;

const glmDir = resolve(desktopRoot, "bundled-agents", platformKey, "glm");
// stage-agent-bundle.mjs resolves where fcode.cjs / .node-bundle-meta.json land (single source).
// After the node_repl host was split into the standalone @fcode/node-repl-host package,
// browser-use stopped producing dist/mcp/server.js, and the CUA assets
// (docs/computer-use.md, scripts/computer-use-client.mjs) moved to @fcode/cua-plugin.
// This list was not updated at the time, so packaging kept asking browser-use for those three
// files and failed with a missing runtime. The dev path uses requiredDevPluginRuntimeBuilds in
// scripts/build-desktop-agent-cli.mjs (which was updated correctly). The two parallel lists are
// maintained separately, so dev could not catch it. The authoritative ownership is in
// bootstrap/official-plugin-definitions.ts.
const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // documents.json already exposes the recording lookup; the desktop installer must not reuse a runtime that lacks the body.
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];
const officialPluginPackages = [
  {
    packageName: "@fcode/remote-host-plugin",
    relativePath: "apps/kcode-cli/packages/remote-host-plugin",
    requiresRuntime: false,
    requiredSeedPaths: ["skills/remote-host-operations/SKILL.md"],
    stagedPath: "packages/remote-host-plugin",
  },
  {
    // The wallet plugin ships only a manifest and a skill: no package.json, no runtime.
    // Without it the packaged app's filesystem seed cannot find koin-wallet, the host
    // never mounts the koincode_wallet MCP server, and every skill that depends on
    // wallet_run_client (such as koinelix) is unusable in the installed build.
    packageName: "koin-wallet-plugin",
    relativePath: "apps/kcode-cli/packages/koin-wallet-plugin",
    requiresRuntime: false,
    requiredSeedPaths: ["skills/wallet-http/SKILL.md"],
    stagedPath: "packages/koin-wallet-plugin",
  },
  {
    packageName: "@fcode/computer-use-plugin",
    relativePath: "apps/kcode-cli/packages/fcode-cua-plugin",
    requiresRuntime: false,
    requiredSeedPaths: ["scripts/computer-use-client.mjs", "docs/computer-use.md", "docs/windows-computer-use.md", "skills/computer-use/SKILL.md"],
    stagedPath: "packages/fcode-cua-plugin",
  },
  {
    // browser-use carries only its own client script and skill/docs; the node_repl MCP runtime
    // belongs to @fcode/node-repl-host (see the comment on the constant above).
    packageName: "@fcode/browser-use-plugin",
    relativePath: "apps/kcode-cli/packages/browser-use-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/browser-use-plugin",
  },

  {
    // node_repl host: the MCP runtime shared by Browser Use and Computer Use, now a standalone package.
    // It has no listing (it is not shown in the plugin marketplace), but the first-launch seed of the
    // production build must get its dist runtime; otherwise node_repl is unreachable whenever bua or cua is enabled.
    packageName: "@fcode/node-repl-host",
    relativePath: "apps/kcode-cli/packages/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/node-repl-host",
  },
];
const includedOfficialPluginTopLevelPaths = new Set([
  ".mcp.json",
  ".fcode-plugin",
  "README.md",
  // Electron production resource copying has its own allowlist; omitting agents leaves the first-launch filesystem seed permanently without subagents.
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  "scripts",
  "skills",
  "templates",
]);
const excludedOfficialPluginAssetNames = new Set([
  ".DS_Store",
  ".venv",
  "__pycache__",
  "node_modules",
]);

function shouldCopyOfficialPluginAsset(sourcePath) {
  const name = basename(sourcePath);
  return !excludedOfficialPluginAssetNames.has(name) && !name.endsWith(".pyc");
}
const isBootstrapWithRemote = process.env.FCODE_BOOTSTRAP_WITH_REMOTE === "1";

function buildCliBundle() {
  console.log("[prepare:agent-bundle] building fcode-cli app-server bundle ...");
  // Reuse the repo root script (turbo build:desktop-agent --filter=@fcode/cli); it is near-instant on a cache hit.
  runCommand(process.execPath, [resolve(repoRoot, "scripts/build-desktop-agent-cli.mjs")], {
    cwd: repoRoot,
    env: pnpmRunEnv,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(
      `[prepare:agent-bundle] expected cli bundle missing after build: ${cliBundlePath}`,
    );
  }
}

function buildOfficialPluginRuntimes() {
  for (const plugin of officialPluginPackages) {
    if (!plugin.requiresRuntime) continue;
    console.log(`[prepare:agent-bundle] building ${plugin.packageName} runtime ...`);
    if (isBootstrapWithRemote) {
      buildOfficialPluginRuntimeForBootstrap(plugin);
      assertOfficialPluginRuntime(plugin);
      continue;
    }

    runCommand(
      "pnpm",
      ["--dir", resolve(repoRoot, "apps/kcode-cli"), "--filter", plugin.packageName, "build"],
      {
        cwd: repoRoot,
        env: pnpmRunEnv,
      },
    );
    assertOfficialPluginRuntime(plugin);
  }
}

function buildOfficialPluginRuntimeForBootstrap(plugin) {
  const pluginRoot = resolve(repoRoot, plugin.relativePath);
  const hasCompleteRuntime = plugin.requiredRuntimePaths.every((relativePath) =>
    existsSync(resolve(pluginRoot, ...relativePath.split("/"))),
  );
  if (plugin.packageName !== BROWSER_USE_PLUGIN_PACKAGE_NAME && hasCompleteRuntime) {
    console.log(
      `[prepare:agent-bundle] reuse existing official plugin runtime: ${plugin.packageName}`,
    );
    return;
  }

  // bootstrap:with-remote builds the remote assets and the desktop agent bundle back to back.
  // When the plugin build is entered through pnpm/filter, the tsc shim is easily SIGKILLed on a low-memory machine.
  // Only under the bootstrap switch, run the equivalent tsc + build-mcp directly with the current Node; the plugin's own build script is unchanged.
  // The browser-use server and browser-client are one release pair: rebuild even when an old server.js exists,
  // otherwise the old server gets staged into the desktop installer with the current (or missing) client.
  runCommand(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
    cwd: pluginRoot,
    env: process.env,
  });
  runCommand(process.execPath, [plugin.runtimeBuildScript], {
    cwd: pluginRoot,
    env: process.env,
  });
}

function assertOfficialPluginRuntime(plugin) {
  const pluginRoot = resolve(repoRoot, plugin.relativePath);
  for (const relativePath of plugin.requiredRuntimePaths) {
    const runtimePath = resolve(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(runtimePath)) {
      throw new Error(`[prepare:agent-bundle] missing official plugin runtime: ${runtimePath}`);
    }
  }
}

function stageBundle() {
  // The implementation lives in stage-agent-bundle.mjs: the dev path (scripts/build-desktop-agent-cli.mjs)
  // must use the same one, otherwise dev keeps running the stale agent left by the previous packaging run.
  stageAgentBundle({ repoRoot, platformKey });
}

function stageOfficialPlugins() {
  for (const plugin of officialPluginPackages) {
    const sourceRoot = resolve(repoRoot, plugin.relativePath);
    const manifestPath = resolve(sourceRoot, ".fcode-plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`[prepare:agent-bundle] missing official plugin manifest: ${manifestPath}`);
    }

    const targetRoot = resolve(glmDir, plugin.stagedPath);
    mkdirSync(targetRoot, { recursive: true });
    for (const entryName of includedOfficialPluginTopLevelPaths) {
      const sourcePath = resolve(sourceRoot, entryName);
      if (!existsSync(sourcePath)) continue;
      cpSync(sourcePath, resolve(targetRoot, entryName), {
        recursive: true,
        filter: shouldCopyOfficialPluginAsset,
      });
    }
    for (const relativePath of plugin.requiredSeedPaths ?? []) {
      const stagedAssetPath = resolve(targetRoot, ...relativePath.split("/"));
      if (!existsSync(stagedAssetPath)) {
        throw new Error(
          `[prepare:agent-bundle] missing staged official plugin seed asset: ${stagedAssetPath}`,
        );
      }
    }
    console.log(`[prepare:agent-bundle] staged official plugin ${plugin.stagedPath}`);
  }
}

// When the Electron production build ships only resources/glm/fcode.cjs, there is no official plugin
// directory near the app-server process's __dirname, the startup seed finds no source, and users do
// not get the built-in plugins automatically. Place the official plugins where bootstrap's
// rootCandidates expect them (glm/packages/*-plugin) so that Electron Node running fcode.cjs reuses
// the same filesystem seed logic.
// Declaration generation for the browser-use runtime depends on @fcode/core/dist, which a clean CI
// checkout does not have. Build the CLI dependencies first, then the official plugins; a leftover
// dist on developer machines used to hide this ordering problem.
buildCliBundle();
buildOfficialPluginRuntimes();
stageBundle();
stageOfficialPlugins();
await stageBundledSkillPack({ repoRoot, glmDir, platform, arch });
