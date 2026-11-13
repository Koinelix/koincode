// Stage the CLI bundle into bundled-agents/<platform>/glm with its metadata.
//
// Development and packaging use the same staging implementation. A packaging-only
// stage can leave development loading an older bundled agent and hide CLI changes.
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const AGENT_BUNDLE_SOURCE_RELATIVE = "apps/kcode-cli/packages/cli/dist/fcode.cjs";
const remoteHostContentFiles = [".fcode-plugin/plugin.json", "README.md", "skills/remote-host-operations/SKILL.md"];

export function resolveAgentBundlePaths({ repoRoot, platformKey }) {
  const glmDir = resolve(repoRoot, "packages", "desktop", "bundled-agents", platformKey, "glm");
  return {
    cliBundlePath: resolve(repoRoot, AGENT_BUNDLE_SOURCE_RELATIVE),
    glmDir,
    stagedBundlePath: resolve(glmDir, "fcode.cjs"),
    stagedMetaPath: resolve(glmDir, ".node-bundle-meta.json"),
  };
}

/**
 * 干净重建 glm 目录再拷贝。清空是刻意的：electron-builder 整目录拷贝
 * bundled-agents/<平台>/glm → resources/glm，本地工作树里上一次构建残留的原生二进制
 * （fcode-agent / fcode-acp 等）和旧 meta 会被一并打进安装包（CI 干净检出不会有，本地会）。
 */
export function stageAgentBundle({ repoRoot, platformKey, log = console.log }) {
  const { cliBundlePath, glmDir, stagedBundlePath, stagedMetaPath } = resolveAgentBundlePaths({
    repoRoot,
    platformKey,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(`[stage:agent-bundle] agent bundle 源产物不存在：${cliBundlePath}`);
  }
  const remoteHostSource = resolve(repoRoot, "apps/kcode-cli/packages/remote-host-plugin");
  for (const file of remoteHostContentFiles) {
    if (!existsSync(resolve(remoteHostSource, file))) {
      throw new Error(`[stage:agent-bundle] missing bundled Remote Host content: ${file}`);
    }
  }
  rmSync(glmDir, { recursive: true, force: true });
  mkdirSync(glmDir, { recursive: true });
  copyFileSync(cliBundlePath, stagedBundlePath);
  // Dev also clears glm; stage the content here so it cannot lose the bundled capability.
  for (const file of remoteHostContentFiles) {
    const target = resolve(glmDir, "packages/remote-host-plugin", file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(remoteHostSource, file), target);
  }
  const meta = {
    runtime: "electron-node",
    entry: "fcode.cjs",
    platform: platformKey,
    source: AGENT_BUNDLE_SOURCE_RELATIVE,
  };
  writeFileSync(stagedMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  log(`[stage:agent-bundle] staged ${stagedBundlePath}`);
  return { stagedBundlePath, stagedMetaPath };
}
