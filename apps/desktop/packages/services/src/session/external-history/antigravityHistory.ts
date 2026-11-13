import { createRequire } from "node:module";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  FCodeImportableSessionCandidate,
  FCodePersistedMessage,
  FCodeSessionImportScanResult,
  SessionImportScanParams,
} from "@fcode/shared";
import type { ClaudeNativeImportedSessionSource } from "../claude-native/claudeNativeImportedSessionTypes.js";
import {
  antigravityEndpoints,
  callAntigravityReadApi,
  readAntigravitySteps,
} from "./antigravityLocalApi.js";
import {
  contentText,
  readHistoryLines,
  record,
  sameWorkspace,
  sourceWorkspacePath,
  string,
  timestamp,
  type HistoryRecord,
} from "./historyFiles.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]{1,200}$/u;

function stepContent(row: HistoryRecord): { role: "user" | "assistant"; content: string } | null {
  const type = string(row.type).replace(/^CORTEX_STEP_TYPE_/, "");
  if (type === "USER_INPUT") {
    const input = record(row.userInput);
    const content = string(row.content) || contentText(input.items) || string(input.userResponse);
    // The source transcript can wrap actual text with automatic runtime metadata.
    const wrapped = content.match(
      /^\s*<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>(?:\s*<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/\2>)*\s*$/u,
    );
    return { role: "user", content: wrapped ? wrapped[1]! : content };
  }
  if (type === "PLANNER_RESPONSE") {
    const response = record(row.plannerResponse);
    const content =
      string(row.content) || string(response.modifiedResponse) || string(response.response);
    return { role: "assistant", content };
  }
  return null;
}
export function parseAntigravityMessages(rows: HistoryRecord[]): FCodePersistedMessage[] {
  return rows.flatMap((row, index) => {
    const item = stepContent(row);
    if (!item?.content.trim()) return [];
    return [
      {
        id: `antigravity-${index}`,
        ...item,
        timestamp: timestamp(row.created_at ?? record(row.metadata).createdAt, index),
      },
    ];
  });
}

async function summariesFromApi(): Promise<HistoryRecord[]> {
  const rows: HistoryRecord[] = [];
  for (const endpoint of await antigravityEndpoints()) {
    try {
      const result = await callAntigravityReadApi(endpoint, "GetAllCascadeTrajectories", {});
      for (const [id, value] of Object.entries(record(result.trajectorySummaries))) {
        const summary = record(value);
        const workspaces = Array.isArray(summary.workspaces) ? summary.workspaces : [];
        rows.push({
          conversation_id: id,
          title: summary.summary ?? summary.title,
          last_modified_time: record(summary.lastModifiedTime).seconds
            ? Number(record(summary.lastModifiedTime).seconds) * 1000
            : summary.lastModifiedTime,
          workspace_uris: JSON.stringify(
            workspaces.map((workspace) => record(workspace).workspaceFolderAbsoluteUri),
          ),
          parent_conversation_id: summary.parentCascadeId,
          step_count: summary.stepCount,
        });
      }
    } catch {
      /* Probe only the process-owned local read endpoints. */
    }
  }
  return rows;
}

export async function scanAntigravityHistory(
  params: SessionImportScanParams,
  root = join(homedir(), ".gemini", "antigravity"),
): Promise<FCodeSessionImportScanResult> {
  const result: FCodeSessionImportScanResult = { candidates: [], diagnostics: [] };
  let rows: HistoryRecord[];
  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    db = new DatabaseSync(join(root, "conversation_summaries.db"), { readOnly: true });
    rows = db
      .prepare(
        "SELECT conversation_id,title,preview,last_modified_time,workspace_uris,parent_conversation_id,step_count FROM conversation_summaries",
      )
      .all() as HistoryRecord[];
  } catch (error) {
    try {
      rows = await summariesFromApi();
    } catch {
      rows = [];
    }
    if (!rows.length)
      result.diagnostics.push({
        reason:
          (error as NodeJS.ErrnoException).code === "EACCES"
            ? "source_read_failed"
            : "antigravity_open_required",
      });
  } finally {
    db?.close();
  }
  for (const row of rows!) {
    const sessionId = string(row.conversation_id);
    if (!SAFE_SESSION_ID.test(sessionId) || string(row.parent_conversation_id)) continue;
    const updatedAt = timestamp(row.last_modified_time, 0);
    if (params.modifiedSince && updatedAt < params.modifiedSince) continue;
    let uris: unknown[] = [];
    try {
      const parsed: unknown = JSON.parse(string(row.workspace_uris) || "[]");
      if (Array.isArray(parsed)) uris = parsed;
    } catch {
      result.diagnostics.push({ sessionId, reason: "source_workspace_invalid" });
    }
    const workspacePaths = [
      ...new Set(uris.map((uri) => sourceWorkspacePath(uri)).filter(Boolean)),
    ];
    const workspacePath = workspacePaths.length === 1 ? workspacePaths[0]! : "";
    if (
      params.workspacePath &&
      !workspacePaths.some((path) => sameWorkspace(path, params.workspacePath!))
    )
      continue;
    result.candidates.push({
      provider: "antigravity",
      sessionId,
      workspacePath,
      ...(workspacePaths.length !== 1 ? { workspacePaths } : {}),
      sourcePath: join(root, "brain", sessionId, ".system_generated", "logs", "transcript.jsonl"),
      sourceStepCount: Number(row.step_count) || undefined,
      updatedAt,
      previewTitle: (string(row.title) || string(row.preview)).slice(0, 100),
    });
  }
  result.candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  result.candidates = result.candidates.slice(0, params.limit);
  if (!result.candidates.length && !result.diagnostics.length)
    result.diagnostics.push({ reason: "source_empty_or_missing" });
  return result;
}

export async function readAntigravityHistory(
  candidate: FCodeImportableSessionCandidate,
): Promise<ClaudeNativeImportedSessionSource> {
  let rows: HistoryRecord[];
  try {
    await access(candidate.sourcePath);
    rows = await readHistoryLines(candidate.sourcePath);
    const lastStep = Math.max(...rows.map((row) => Number(row.step_index) || 0));
    if (candidate.sourceStepCount && lastStep < candidate.sourceStepCount - 1)
      throw new Error("source_transcript_incomplete");
    if (
      rows.some(
        (row) => Array.isArray(row.truncated_fields) && row.truncated_fields.includes("content"),
      )
    )
      throw new Error("source_transcript_truncated");
    if (!parseAntigravityMessages(rows).length) throw new Error("source_messages_missing");
  } catch {
    rows = await readAntigravitySteps(candidate.sessionId);
  }
  const messages = parseAntigravityMessages(rows);
  return {
    ...candidate,
    createdAt: messages[0]?.timestamp ?? candidate.updatedAt,
    title:
      candidate.previewTitle ||
      messages.find((message) => message.role === "user")?.content.slice(0, 100),
    migrationSource: "antigravity",
    messages,
  };
}
