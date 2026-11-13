// Composer Skill 只读 catalog。
// 与 Skills Settings 管理接口分离：这里的 sessionId 决定 authority，不提供启停/删除能力。
import {
  fcodeSkillsReferenceCatalogParamsSchema,
  type FCodeSkillReferenceCatalogEntry,
  type FCodeSkillsReferenceCatalogResult,
} from "@fcode/shared";
import type { SkillLoadOutcome, SkillMetadata } from "@fcode/contracts";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { listFCodeSkills } from "../skills.js";
import {
  parseParams,
  requireSession,
  type FCodeProtocolAgentServerContext,
} from "./server-types.js";

export async function getSkillReferenceCatalog(
  context: FCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<FCodeSkillsReferenceCatalogResult> {
  const params = parseParams(fcodeSkillsReferenceCatalogParamsSchema, rawParams);
  if (params.sessionId) {
    const record = requireSession(context, params.sessionId);
    const outcome = await record.app.getSkillCatalog();
    return toResult("session", outcome, params.includeBuiltIn === true);
  }

  // 旧 UI cache 只在 workspace 首次挂载时扫描，用户从文件系统手动新增
  // Skill 后，新建对话仍停在旧快照。草稿请求在 Agent 侧复用 CLI 正式发现配置，
  // 每次新打开引用面板都读取当前 workspace catalog。
  const outcome = await listFCodeSkills({
    env: context.deps.env,
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  return toResult("workspace", outcome, params.includeBuiltIn === true);
}

async function toResult(
  authority: FCodeSkillsReferenceCatalogResult["authority"],
  outcome: SkillLoadOutcome,
  includeBuiltIn: boolean,
): Promise<FCodeSkillsReferenceCatalogResult> {
  return {
    authority,
    // Only the explicitly exposed Skill is selectable; internal workflow instructions stay hidden.
    // Older clients do not opt in and retain the original closed scope enum.
    skills: await Promise.all(outcome.skills
      .filter((skill) => skill.source !== "bundled" || (includeBuiltIn && skill.name === "koinelix"))
      .map(toReferenceCatalogEntry)),
  };
}

async function snapshotDigest(skill: SkillMetadata): Promise<string | undefined> {
  if (skill.source !== "bundled" || skill.name !== "koinelix") return undefined;
  let file;
  try {
    const directory = await realpath(dirname(skill.path));
    if (relative(await realpath(skill.rootPath), directory) !== "koinelix") return undefined;
    const manifestPath = join(directory, "snapshot.json");
    const before = await lstat(manifestPath);
    if (!before.isFile() || before.isSymbolicLink()) return undefined;
    file = await open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await file.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size <= 0 || info.size > 1024 * 1024) return undefined;
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length !== info.size) return undefined;
    return createHash("sha256").update(bytes.subarray(0, length)).digest("hex");
  } catch {
    return undefined;
  } finally {
    await file?.close();
  }
}

async function toReferenceCatalogEntry(skill: SkillMetadata): Promise<FCodeSkillReferenceCatalogEntry> {
  const scope =
    skill.source === "bundled" ? "built-in" : skill.source === "plugin" ? "plugin" : skill.scope === "project" ? "workspace" : "user";
  const snapshotSha256 = await snapshotDigest(skill);
  return {
    // `glm:` 是现有 UI provider 过滤契约；路径使同名不同来源仍有稳定行身份。
    id: `glm:${scope}:${skill.path}`,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    scope,
    enabled: true,
    ...(snapshotSha256 ? { snapshotSha256 } : {}),
    ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
    ...(skill.pluginId ? { pluginId: skill.pluginId } : {}),
  };
}
