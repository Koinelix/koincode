import { REMOTE_HOST_LIMITS, RemoteHostError, remoteExecutionOutputArtifactId, type RemoteExecutionRecord,
  type RemoteHostManagementInput, type RemoteExecutionOutputPage } from "@fcode/shared";
import { RemoteExecutionJournal } from "./executionJournal.js";
import { readRemoteExecutionOutput, removeRemoteExecutionOutput } from "./outputReader.js";

/** Access-based maintenance and local viewing share one bounded broker queue. */
export class RemoteExecutionDetails {
  private queue = Promise.resolve();
  private pending = 0;
  private stopped = false;
  private readonly controller = new AbortController();
  constructor(private readonly journal: RemoteExecutionJournal, private readonly root: string,
    private readonly ownerId: string, private readonly clock = () => Date.now()) {}

  access(records: RemoteExecutionRecord[]): Promise<{ records: RemoteExecutionRecord[]; maintenancePending: boolean }> {
    if (records.length > REMOTE_HOST_LIMITS.hostCount) return Promise.reject(new RemoteHostError("transfer_limit", "The output maintenance record budget was exceeded."));
    return this.serial(() => this.maintain(records));
  }

  read(input: RemoteHostManagementInput<"readExecutionOutput">): Promise<RemoteExecutionOutputPage> {
    return this.serial(async () => {
      const record = this.journal.get(input.executionId);
      this.assertOwned(record);
      if (record.outputArtifactId && record.outputArtifactId !== remoteExecutionOutputArtifactId(record.executionId, record.attempt)) {
        throw new RemoteHostError("storage_corrupt", "The saved output artifact reference is invalid.", "storage");
      }
      if (record.context.workspaceKey !== input.workspaceKey || record.context.sessionId !== input.sessionId ||
        input.artifactId !== remoteExecutionOutputArtifactId(record.executionId, record.attempt)) {
        throw new RemoteHostError("permission_denied", "The output artifact belongs to another execution or conversation.", "authorization");
      }
      if (record.operation !== "exec") throw new RemoteHostError("capability_unavailable", "This operation has no command-output artifact.");
      const maintained = await this.maintain([record]); const current = maintained.records[0]!;
      if (current.outputExpiredAt !== undefined) return { artifactId: input.artifactId, available: false, expired: true,
        fileBytes: 0, entries: [], incompleteTail: false, maintenancePending: maintained.maintenancePending };
      const page = await readRemoteExecutionOutput(this.root, record.executionId, record.attempt, input.artifactId,
        input.cursor, input.limit ?? 16 * 1024, AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)]));
      return { ...page, maintenancePending: maintained.maintenancePending };
    });
  }

  async dispose(): Promise<void> { this.stopped = true; this.controller.abort(); await this.queue; }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new RemoteHostError("canceled", "Local output access has stopped."));
    if (this.pending >= 64) return Promise.reject(new RemoteHostError("storage_busy", "Too many local output requests are pending."));
    this.pending++;
    const result = this.queue.then(() => { this.controller.signal.throwIfAborted(); return action(); });
    this.queue = result.then(() => {}, () => {});
    return result.finally(() => { this.pending--; });
  }

  private assertOwned(record: RemoteExecutionRecord): void {
    if (record.context.ownerId !== this.ownerId) throw new RemoteHostError("permission_denied", "This output belongs to another local owner.", "authorization");
  }

  private async maintain(records: RemoteExecutionRecord[]) {
    for (const record of records) this.assertOwned(record);
    const now = this.clock(); let eventBudget = 500; let maintenancePending = false;
    const values: RemoteExecutionRecord[] = [];
    for (const requested of records) {
      this.controller.signal.throwIfAborted();
      let record = this.journal.get(requested.executionId); this.assertOwned(record);
      if (!["succeeded", "failed", "canceled"].includes(record.state)) {
        if (record.outputExpiredAt !== undefined || record.outputPurgedAt !== undefined || record.eventsPurgedAt !== undefined) {
          throw new RemoteHostError("storage_corrupt", "An active or uncertain execution has inconsistent retention markers.", "storage");
        }
        values.push(record); continue;
      }
      if (record.outputExpiredAt === undefined && record.updatedAt + REMOTE_HOST_LIMITS.retentionMs > now) { values.push(record); continue; }
      try { record = this.journal.expireOutput(record.executionId, now); }
      catch {
        maintenancePending = true;
        if (["succeeded", "failed", "canceled"].includes(record.state) && record.updatedAt + REMOTE_HOST_LIMITS.retentionMs <= now) {
          // Logical expiration still prevents disclosure if persisting its marker failed.
          record = { ...record, result: undefined, outputExpiredAt: record.updatedAt + REMOTE_HOST_LIMITS.retentionMs };
        }
        values.push(record); continue;
      }
      if (record.outputExpiredAt !== undefined) {
        if (record.outputPurgedAt === undefined) {
          try {
            await removeRemoteExecutionOutput(this.root, record.executionId, record.attempt);
            record = this.journal.markOutputPurged(record.executionId, now);
          } catch { maintenancePending = true; }
        }
        if (record.eventsPurgedAt === undefined && eventBudget > 0) {
          try { eventBudget -= this.journal.purgeExpiredEvents(record.executionId, now, eventBudget); record = this.journal.get(record.executionId); }
          catch { maintenancePending = true; }
        }
        if (record.eventsPurgedAt === undefined) maintenancePending = true;
      }
      values.push(record);
    }
    return { records: values, maintenancePending };
  }
}
