import { createHash } from "node:crypto";
import { normalize, win32 } from "node:path";
import type { FCodeTaskMeta } from "@fcode/shared";
import { generateTraceId } from "@fcode/shared";
import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import type { ClaudeNativeImportedSessionSource } from "#src/session/claude-native/claudeNativeImportedSessionTypes.js";
import type { LegacyTaskSessionFile } from "#src/session/legacyTaskSessionFile.js";
import {
  DEFAULT_IMPORTED_CLAUDE_TASK_FILTER_PATHS,
  filterImportedClaudeTaskFilePaths,
} from "#src/session/claude-native/importedClaudeTaskFileFilter.js";

export function buildImportedClaudeTaskId(workspacePath: string, sessionId: string): string {
  const digest = createHash("sha256")
    .update(`claude:${workspacePath}:${sessionId}`)
    .digest("hex")
    .slice(0, 24);
  return `claude-import-${digest}`;
}

export function buildImportedSessionTaskId(
  source: ClaudeNativeImportedSessionSource,
  workspaceIdentity?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (source.provider === "claude")
    return buildImportedClaudeTaskId(source.workspacePath, source.sessionId);
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        source.provider,
        workspaceIdentity ??
          (platform === "win32"
            ? win32.resolve(source.workspacePath).toLowerCase()
            : normalize(source.workspacePath)),
        source.sessionId,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  return `${source.provider}-import-${digest}`;
}

function deriveImportedTaskTitle(
  fallbackTitle: string | undefined,
  messages: ClaudeNativeImportedSessionSource["messages"],
): string {
  const explicitTitle = fallbackTitle?.trim();
  if (explicitTitle) {
    return explicitTitle;
  }

  const firstUserMessage = messages.find(
    (message) => message.role === "user" && message.content.trim().length > 0,
  );
  return firstUserMessage ? deriveSessionTitle(firstUserMessage.content, []) : "Imported session";
}

export function buildImportedClaudeTaskFile(
  source: ClaudeNativeImportedSessionSource,
  filterPaths: readonly string[] = DEFAULT_IMPORTED_CLAUDE_TASK_FILTER_PATHS,
  taskIdOverride?: string,
): LegacyTaskSessionFile {
  if (source.messages.length === 0) {
    throw new Error(`External session ${source.sessionId} has no visible messages to import`);
  }

  const taskId = taskIdOverride ?? buildImportedSessionTaskId(source);
  const traceId = generateTraceId(taskId);
  const createdAt = Number.isFinite(source.createdAt) ? source.createdAt : source.updatedAt;
  const updatedAt = Number.isFinite(source.updatedAt) ? source.updatedAt : createdAt;

  const meta: FCodeTaskMeta = {
    taskId,
    traceId,
    title: deriveImportedTaskTitle(source.title, source.messages),
    workspacePath: source.workspacePath,
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt),
    mode: "build",
    migrationSource: source.provider === "claude" ? "claudeCode" : source.provider,
    status: "completed",
    ...(source.model ? { model: source.model } : {}),
  };

  const taskFile: LegacyTaskSessionFile = {
    meta,
    messages: [...source.messages],
  };

  // Source runtime choices must not override FCode model or permission settings.
  // Keep visible content and provenance through the existing snapshot filter.
  return filterImportedClaudeTaskFilePaths(taskFile, filterPaths);
}
