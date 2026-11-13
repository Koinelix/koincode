import { stat, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  FCodeSessionImportScanResult,
  FCodeImportableSessionCandidate,
  FCodePersistedMessage,
  SessionImportScanParams,
} from "@fcode/shared";
import type { ClaudeNativeImportedSessionSource } from "../claude-native/claudeNativeImportedSessionTypes.js";
import {
  contentText,
  historyFiles,
  readHistoryLines,
  record,
  sameWorkspace,
  sourceWorkspacePath,
  string,
  timestamp,
  type HistoryRecord,
} from "./historyFiles.js";

export function parseCodexMessages(records: HistoryRecord[]): FCodePersistedMessage[] {
  const canonical: FCodePersistedMessage[] = [];
  const legacy: FCodePersistedMessage[] = [];
  const seen = new Set<string>();
  for (const row of records) {
    const payload = record(row.payload);
    const time = timestamp(row.timestamp, canonical.length + legacy.length);
    if (
      row.type === "response_item" &&
      payload.type === "message" &&
      (payload.role === "user" || payload.role === "assistant")
    ) {
      const content = contentText(payload.content);
      if (!content.trim()) continue;
      if (payload.role === "user") {
        const kinds = record(payload.internal_chat_message_metadata_passthrough).content_item_kinds;
        if (
          Array.isArray(kinds) &&
          kinds.length &&
          !kinds.some((kind) => string(kind).startsWith("user."))
        )
          continue;
        if (
          !Array.isArray(kinds) &&
          /^(?:# AGENTS\.md instructions for [\s\S]*<\/INSTRUCTIONS>\s*(?:<environment_context>[\s\S]*<\/environment_context>)?|<environment_context>[\s\S]*<\/environment_context>|<external_codex_apps_open_page>[\s\S]*<\/external_codex_apps_open_page>)\s*$/u.test(
            content,
          )
        )
          continue;
      }
      const id = string(payload.id);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      canonical.push({
        id: `codex-${canonical.length}`,
        role: payload.role,
        content,
        timestamp: time,
      });
    } else if (
      row.type === "event_msg" &&
      (payload.type === "user_message" || payload.type === "agent_message")
    ) {
      const content = string(payload.message);
      if (content.trim())
        legacy.push({
          id: `codex-legacy-${legacy.length}`,
          role: payload.type === "user_message" ? "user" : "assistant",
          content,
          timestamp: time,
        });
    }
  }
  return canonical.length ? canonical : legacy;
}

export async function scanCodexHistory(
  params: SessionImportScanParams,
  root = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
): Promise<FCodeSessionImportScanResult> {
  const result: FCodeSessionImportScanResult = { candidates: [], diagnostics: [] };
  const titles = new Map<string, string>();
  try {
    const indexPath = join(root, "session_index.jsonl");
    await access(indexPath);
    for (const entry of await readHistoryLines(indexPath)) {
      if (string(entry.id) && string(entry.thread_name))
        titles.set(string(entry.id), string(entry.thread_name));
    }
  } catch {
    /* The rollout remains authoritative when the optional title index is unavailable. */
  }
  for (const directory of ["sessions", "archived_sessions"]) {
    let files;
    try {
      files = await historyFiles(join(root, directory), ".jsonl");
    } catch {
      result.diagnostics.push({ reason: "source_read_failed" });
      continue;
    }
    for (const path of files) {
      try {
        const info = await stat(path);
        if (params.modifiedSince && info.mtimeMs < params.modifiedSince) continue;
        const head = await readHistoryLines(path, 16);
        const meta = record(head.find((row) => row.type === "session_meta")?.payload);
        const sessionId = string(meta.id) || string(meta.session_id);
        if (!sessionId) throw new Error("source_metadata_missing");
        const origin = meta.source ?? meta.thread_source;
        if (record(origin).subagent || /subagent/i.test(string(origin))) continue;
        const workspacePath = sourceWorkspacePath(meta.cwd);
        if (params.workspacePath && !sameWorkspace(workspacePath, params.workspacePath)) continue;
        const candidate: FCodeImportableSessionCandidate = {
          provider: "codex",
          sessionId,
          workspacePath,
          sourcePath: path,
          updatedAt: Math.trunc(info.mtimeMs),
          createdAt: timestamp(meta.timestamp, info.birthtimeMs),
          previewTitle:
            titles.get(sessionId) ||
            parseCodexMessages(head)
              .find((message) => message.role === "user")
              ?.content.slice(0, 100),
        };
        result.candidates.push(candidate);
      } catch (error) {
        result.diagnostics.push({
          reason: error instanceof Error ? error.message : "source_read_failed",
        });
      }
    }
  }
  const unique = new Map<string, FCodeImportableSessionCandidate>();
  for (const candidate of result.candidates.sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (!unique.has(candidate.sessionId)) unique.set(candidate.sessionId, candidate);
  }
  result.candidates = [...unique.values()].slice(0, params.limit);
  if (!unique.size && !result.diagnostics.length)
    result.diagnostics.push({ reason: "source_empty_or_missing" });
  return result;
}

export async function readCodexHistory(
  candidate: FCodeImportableSessionCandidate,
): Promise<ClaudeNativeImportedSessionSource> {
  const messages = parseCodexMessages(await readHistoryLines(candidate.sourcePath));
  return {
    ...candidate,
    createdAt: candidate.createdAt ?? candidate.updatedAt,
    title:
      candidate.previewTitle ||
      messages.find((message) => message.role === "user")?.content.slice(0, 100),
    migrationSource: "codex",
    messages,
  };
}
