import { stat } from "node:fs/promises";
import type {
  FCodeImportSessionsResult,
  FCodeTaskMeta,
  SessionImportParams,
  SessionImportScanParams,
} from "@fcode/shared";
import { sessionImportParamsSchema, sessionImportScanParamsSchema } from "@fcode/shared";
import {
  buildImportedClaudeTaskFile,
  buildImportedSessionTaskId,
} from "../claude-native/buildImportedClaudeTaskFile.js";
import type { ClaudeNativeImportedSessionSource } from "../claude-native/claudeNativeImportedSessionTypes.js";
import {
  buildSearchableTextFromMessages,
  writeImportedClaudeTaskSnapshot,
} from "../claude-native/persistImportedClaudeTask.js";
import type { TaskIndexRepo } from "../taskIndexRepo.js";
import { scanCodexHistory, readCodexHistory } from "./codexHistory.js";
import { scanAntigravityHistory, readAntigravityHistory } from "./antigravityHistory.js";
import { sourceWorkspacePath } from "./historyFiles.js";

export async function scanExternalHistory(input: SessionImportScanParams) {
  const params = sessionImportScanParamsSchema.parse(input);
  const result =
    params.source === "codex"
      ? await scanCodexHistory(params)
      : params.source === "antigravity"
        ? await scanAntigravityHistory(params)
        : undefined;
  if (!result) throw new Error("unsupported_history_source");
  await Promise.all(
    result.candidates.map(async (candidate) => {
      if (!candidate.workspacePath) return;
      try {
        if ((await stat(candidate.workspacePath)).isDirectory()) return;
      } catch {
        // An explicit destination is required when the original directory is unavailable.
      }
      candidate.workspacePaths = [candidate.workspacePath];
      candidate.workspacePath = "";
      result.diagnostics.push({ sessionId: candidate.sessionId, reason: "workspace_path_missing" });
    }),
  );
  return result;
}

export async function importExternalHistory(
  input: SessionImportParams,
  deps: {
    taskIndexRepo: TaskIndexRepo;
    createSession: (
      source: ClaudeNativeImportedSessionSource,
      taskId: string,
      workspaceIdentity?: string,
    ) => Promise<FCodeTaskMeta>;
    onImported: (meta: FCodeTaskMeta) => void;
  },
): Promise<FCodeImportSessionsResult> {
  const params = sessionImportParamsSchema.parse(input);
  const result: FCodeImportSessionsResult = { imported: [], skipped: [], failed: [] };
  const scan = await scanExternalHistory({
    source: params.source,
    workspacePath: params.workspacePath,
  });
  const candidates = new Map(scan.candidates.map((candidate) => [candidate.sessionId, candidate]));
  for (const sessionId of new Set(params.sessionIds)) {
    const candidate = candidates.get(sessionId);
    if (!candidate) {
      result.skipped.push({
        provider: params.source,
        sessionId,
        reason: "session_not_found_or_workspace_mismatch",
      });
      continue;
    }
    try {
      const targetPath = params.targetWorkspacePaths?.[sessionId];
      const workspacePath = targetPath ? sourceWorkspacePath(targetPath) : candidate.workspacePath;
      if (!workspacePath) throw new Error("target_workspace_required");
      let workspaceStat;
      try {
        workspaceStat = await stat(workspacePath);
      } catch {
        throw new Error("workspace_path_missing");
      }
      if (!workspaceStat.isDirectory()) throw new Error("target_workspace_not_directory");
      const identity = params.workspacePath && !targetPath ? params.workspaceIdentity : undefined;
      const source =
        params.source === "codex"
          ? await readCodexHistory(candidate)
          : await readAntigravityHistory(candidate);
      if (!source.messages.length) throw new Error("source_messages_missing");
      source.workspacePath = workspacePath;
      const taskId = buildImportedSessionTaskId(source, identity);
      const meta = await deps.createSession(source, taskId, identity);
      const snapshot = buildImportedClaudeTaskFile(source, undefined, taskId);
      snapshot.meta.workspaceIdentity = identity;
      await writeImportedClaudeTaskSnapshot({ sessionFile: snapshot });
      const indexed = await deps.taskIndexRepo.syncTaskMeta({
        meta: { ...meta, migrationSource: source.migrationSource, workspaceIdentity: identity },
        searchableText: buildSearchableTextFromMessages(snapshot.messages),
        archived: false,
        deleted: false,
      });
      deps.onImported(indexed);
      result.imported.push({ provider: params.source, sessionId, taskId, workspacePath });
    } catch (error) {
      result.failed.push({
        provider: params.source,
        sessionId,
        workspacePath: candidate.workspacePath,
        reason: error instanceof Error ? error.message : "history_import_failed",
      });
    }
  }
  return result;
}
