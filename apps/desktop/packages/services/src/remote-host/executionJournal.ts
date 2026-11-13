import {
  REMOTE_HOST_LIMITS, RemoteHostError, remoteExecutionRecordSchema, remoteExecutionEventSchema,
  type RemoteExecutionRecord, type RemoteExecutionState, type RemoteExecutionEvent,
} from "@fcode/shared";
import { RemoteHostDatabase } from "./database.js";
import { remoteInputDigest } from "./canonicalInput.js";
import { remoteRecoveryEvidenceSchema, type RemoteRecoveryEvidence } from "./recoveryEvidence.js";

const INTERRUPTED_STATES: RemoteExecutionState[] = ["dispatching", "running", "verifying", "cancel_requested", "reconciling"];
const UNSTARTED_STATES: RemoteExecutionState[] = ["preparing", "preflight", "awaiting_approval", "queued"];
const TRANSITIONS: Record<RemoteExecutionState, readonly RemoteExecutionState[]> = {
  preparing: ["preflight", "canceled", "failed"], preflight: ["awaiting_approval", "canceled", "failed"],
  awaiting_approval: ["queued", "canceled", "failed"], queued: ["dispatching", "canceled", "failed"],
  dispatching: ["running", "cancel_requested", "execution_unknown", "failed"],
  running: ["verifying", "succeeded", "failed", "cancel_requested", "execution_unknown"],
  verifying: ["succeeded", "failed", "cancel_requested", "execution_unknown"],
  cancel_requested: ["canceled", "execution_unknown", "succeeded", "failed"],
  execution_unknown: ["reconciling"], reconciling: ["succeeded", "failed", "needs_review", "execution_unknown"],
  needs_review: ["reconciling"], succeeded: [], failed: [], canceled: [],
};
const IMMUTABLE_FIELDS = ["executionId", "attempt", "retryOf", "context", "hostId", "securityRevision", "trustRevision", "display",
  "operation", "requestId", "approvalId", "operationDigest", "createdAt", "dispatchExpiresAt", "sourceId", "snapshotId", "manifestHash", "remotePath"] as const;

function decode(value: unknown): RemoteExecutionRecord {
  try {
    if (typeof value !== "string") throw new Error("Missing execution");
    return remoteExecutionRecordSchema.parse(JSON.parse(value));
  } catch { throw new RemoteHostError("storage_corrupt", "An execution record is invalid.", "storage"); }
}

export class RemoteExecutionJournal {
  constructor(private readonly database: RemoteHostDatabase) {}

  get(executionId: string): RemoteExecutionRecord {
    const row = this.database.connection.prepare("SELECT document FROM remote_executions WHERE execution_id = ?").get(executionId);
    if (!row) throw new RemoteHostError("execution_not_found", "The remote execution was not found.", "storage");
    return decode(row.document);
  }

  list(sessionId?: string): RemoteExecutionRecord[] {
    const rows = sessionId
      ? this.database.connection.prepare("SELECT document FROM remote_executions WHERE session_id = ? ORDER BY execution_id").all(sessionId)
      : this.database.connection.prepare("SELECT document FROM remote_executions ORDER BY execution_id").all();
    return rows.map((row) => decode(row.document));
  }

  recoveryEvidence(executionId: string): RemoteRecoveryEvidence | null {
    const record = this.get(executionId);
    const row = this.database.connection.prepare("SELECT document FROM remote_approval_records WHERE approval_id = ?").get(record.approvalId);
    if (!row || typeof row.document !== "string") return null;
    try {
      const document: unknown = JSON.parse(row.document);
      if (!document || typeof document !== "object" || !("recovery" in document) || !Array.isArray(document.recovery)) return null;
      const raw = document.recovery.find((item: unknown) => item && typeof item === "object" && "hostId" in item && item.hostId === record.hostId);
      if (!raw) return null;
      const evidence = remoteRecoveryEvidenceSchema.parse(raw);
      if (evidence.remotePath !== record.remotePath) throw new Error("Mismatched recovery path");
      return evidence;
    } catch { throw new RemoteHostError("storage_corrupt", "The saved recovery evidence is invalid.", "storage"); }
  }

  page(input: { sessionId: string; workspaceKey: string; cursor?: string; limit: number }): { items: RemoteExecutionRecord[]; nextCursor?: string } {
    const cursor = input.cursor ? this.get(input.cursor) : undefined;
    if (cursor && (cursor.context.workspaceKey !== input.workspaceKey || cursor.context.sessionId !== input.sessionId)) {
      throw new RemoteHostError("permission_denied", "The execution cursor belongs to another conversation.", "authorization");
    }
    const rows = this.database.connection.prepare(`SELECT document FROM remote_executions
      WHERE session_id = ? AND json_extract(document, '$.context.workspaceKey') = ?
      AND (? IS NULL OR json_extract(document, '$.createdAt') < ? OR
        (json_extract(document, '$.createdAt') = ? AND execution_id < ?))
      ORDER BY json_extract(document, '$.createdAt') DESC, execution_id DESC LIMIT ?`)
      .all(input.sessionId, input.workspaceKey, cursor?.createdAt ?? null, cursor?.createdAt ?? null,
        cursor?.createdAt ?? null, cursor?.executionId ?? null, input.limit + 1);
    const records = rows.map((row) => decode(row.document)); const items = records.slice(0, input.limit);
    return { items, ...(records.length > input.limit ? { nextCursor: items.at(-1)!.executionId } : {}) };
  }

  findRequest(key: string, inputDigest: string): string[] | null {
    const row = this.database.connection.prepare("SELECT input_digest, document FROM remote_operation_requests WHERE request_key = ?").get(key);
    if (!row) return null;
    if (row.input_digest !== inputDigest) throw new RemoteHostError("idempotency_conflict", "This operation request identifier was used for different input.", "authorization");
    const value: unknown = JSON.parse(String(row.document));
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new RemoteHostError("storage_corrupt", "The operation request index is invalid.", "storage");
    return value;
  }

  accept(input: { requestKey: string; inputDigest: string; approvalId: string;
    approvalEvidence: Record<string, unknown>; executions: RemoteExecutionRecord[] }): string[] {
    const records = input.executions.map((record) => remoteExecutionRecordSchema.parse(record));
    if (!records.length || records.some((record) => record.state !== "queued" || record.approvalId !== input.approvalId) ||
      new Set(records.map((record) => record.executionId)).size !== records.length) throw new RemoteHostError("invalid_request", "Accepted execution records must be distinct queued permits for one approval.");
    return this.database.transaction(() => {
      const previous = this.findRequest(input.requestKey, input.inputDigest);
      if (previous) return previous;
      this.database.connection.prepare("INSERT INTO remote_approval_records(approval_id, document) VALUES (?, ?)")
        .run(input.approvalId, JSON.stringify(input.approvalEvidence));
      for (const record of records) {
        this.database.connection.prepare(`INSERT INTO remote_executions(execution_id, session_id, host_id, state, document)
          VALUES (?, ?, ?, ?, ?)`).run(record.executionId, record.context.sessionId, record.hostId, record.state, JSON.stringify(record));
        this.event(record);
      }
      const ids = records.map((record) => record.executionId);
      this.database.connection.prepare("INSERT INTO remote_operation_requests(request_key, input_digest, document) VALUES (?, ?, ?)")
        .run(input.requestKey, input.inputDigest, JSON.stringify(ids));
      return ids;
    });
  }

  update(executionId: string, expected: readonly RemoteExecutionState[], patch: Partial<RemoteExecutionRecord>): RemoteExecutionRecord {
    return this.database.transaction(() => {
      const previous = this.get(executionId);
      if (!expected.includes(previous.state)) throw new RemoteHostError("revision_conflict", "The execution state changed before the update.", "execution");
      const next = remoteExecutionRecordSchema.parse({ ...previous, ...patch, updatedAt: Date.now() });
      if (IMMUTABLE_FIELDS.some((key) => remoteInputDigest(next[key] ?? null) !== remoteInputDigest(previous[key] ?? null))) {
        throw new RemoteHostError("permission_denied", "Execution identity cannot change during a state update.", "authorization");
      }
      if (next.state !== previous.state && !TRANSITIONS[previous.state].includes(next.state)) throw new RemoteHostError("revision_conflict", "The execution state transition is not allowed.", "execution");
      this.database.connection.prepare("UPDATE remote_executions SET state=?, document=? WHERE execution_id=?")
        .run(next.state, JSON.stringify(next), executionId);
      this.event(next);
      return next;
    });
  }

  events(executionId: string, afterSequence: number, limit = 200): RemoteExecutionEvent[] {
    return this.database.connection.prepare(`SELECT sequence, document FROM remote_execution_events
      WHERE execution_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`).all(executionId, afterSequence, limit)
      .map((row) => remoteExecutionEventSchema.parse({ ...JSON.parse(String(row.document)), sequence: Number(row.sequence) }));
  }

  expireOutput(executionId: string, now: number): RemoteExecutionRecord {
    if (!Number.isSafeInteger(now) || now < 0) throw new RemoteHostError("invalid_request", "Invalid retention timestamp.");
    return this.database.transaction(() => {
      const record = this.get(executionId);
      if (record.context.ownerId !== this.database.ownerId || !["succeeded", "failed", "canceled"].includes(record.state) ||
        record.updatedAt + REMOTE_HOST_LIMITS.retentionMs > now) return record;
      if (record.outputExpiredAt !== undefined && record.result === undefined) return record;
      return this.saveMaintenance({ ...record, result: undefined, outputExpiredAt: record.outputExpiredAt ?? record.updatedAt + REMOTE_HOST_LIMITS.retentionMs });
    });
  }

  markOutputPurged(executionId: string, now: number): RemoteExecutionRecord {
    return this.database.transaction(() => {
      const record = this.get(executionId);
      if (record.context.ownerId !== this.database.ownerId || record.outputExpiredAt === undefined || !["succeeded", "failed", "canceled"].includes(record.state)) {
        throw new RemoteHostError("revision_conflict", "The execution is not eligible for output cleanup.", "storage");
      }
      return this.saveMaintenance({ ...record, outputPurgedAt: record.outputPurgedAt ?? now });
    });
  }

  purgeExpiredEvents(executionId: string, now: number, limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 500) throw new RemoteHostError("invalid_request", "Invalid event cleanup budget.");
    return this.database.transaction(() => {
      const record = this.get(executionId);
      if (record.context.ownerId !== this.database.ownerId || record.outputExpiredAt === undefined || record.eventsPurgedAt !== undefined || !["succeeded", "failed", "canceled"].includes(record.state)) return 0;
      const result = this.database.connection.prepare(`DELETE FROM remote_execution_events WHERE sequence IN
        (SELECT sequence FROM remote_execution_events WHERE execution_id = ? ORDER BY sequence LIMIT ?)`).run(executionId, limit);
      if (!this.database.connection.prepare("SELECT 1 FROM remote_execution_events WHERE execution_id = ? LIMIT 1").get(executionId)) {
        this.saveMaintenance({ ...record, eventsPurgedAt: now });
      }
      return Number(result.changes);
    });
  }

  private saveMaintenance(record: RemoteExecutionRecord): RemoteExecutionRecord {
    const next = remoteExecutionRecordSchema.parse(record);
    // Retention never changes the business timestamp, permit, state or event sequence.
    this.database.connection.prepare("UPDATE remote_executions SET document = ? WHERE execution_id = ?").run(JSON.stringify(next), next.executionId);
    return next;
  }

  recoverInterrupted(): number {
    let changed = 0;
    for (const execution of this.list()) {
      if (INTERRUPTED_STATES.includes(execution.state)) {
        this.update(execution.executionId, [execution.state], { state: "execution_unknown",
          error: new RemoteHostError("execution_unknown", "The broker exited before a verified receipt was saved.", "execution").toJSON() });
        changed++;
      } else if (UNSTARTED_STATES.includes(execution.state)) {
        this.update(execution.executionId, [execution.state], { state: "canceled", cancelReason: "runtime_restarted" });
        changed++;
      }
    }
    return changed;
  }

  private event(record: RemoteExecutionRecord): void {
    const event: Omit<RemoteExecutionEvent, "sequence"> = { eventVersion: 1, executionId: record.executionId,
      hostId: record.hostId, attempt: record.attempt, timestamp: record.updatedAt,
      traceId: record.context.traceId, state: record.state,
      ...(record.uploadedBytes !== undefined ? { uploadedBytes: record.uploadedBytes } : {}),
      ...(record.uploadedFiles !== undefined ? { uploadedFiles: record.uploadedFiles } : {}) };
    this.database.connection.prepare("INSERT INTO remote_execution_events(execution_id, document) VALUES (?, ?)")
      .run(record.executionId, JSON.stringify(event));
  }
}
