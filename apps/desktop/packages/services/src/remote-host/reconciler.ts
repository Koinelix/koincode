import { createHash, randomUUID } from "node:crypto";
import { REMOTE_HOST_LIMITS, RemoteHostError, remoteHostFailure, type RemoteExecutionRecord,
  type RemoteReconciliationPreview, type RemoteHostRecord } from "@fcode/shared";
import { RemoteExecutionJournal } from "./executionJournal.js";
import { RemoteHostRepository } from "./hostRepository.js";
import { RemoteConnectionManager } from "./connectionManager.js";
import { RemoteOperationScheduler } from "./scheduler.js";
import { RemotePathGuard } from "./remotePaths.js";
import { inspectRemotePath, remoteFileHash, verifyRemoteManifest } from "./remoteFileEvidence.js";
import { remoteManifestHash } from "./snapshotManifest.js";
import { remoteEndpoint } from "./hostCatalog.js";
import type { RemoteRecoveryEvidence } from "./recoveryEvidence.js";

interface Scope { workspaceKey: string; sessionId: string }
interface Ticket { scope: Scope; clientInstanceId: string; record: RemoteExecutionRecord; preview: RemoteReconciliationPreview }
const MAX_TICKETS = 512;
const RECONCILABLE = new Set(["execution_unknown", "needs_review"]);

/** Main-only, one-shot read authority. It never receives or replays a shell command. */
export class RemoteExecutionReconciler {
  private readonly tickets = new Map<string, Ticket>();
  private readonly running = new Map<Promise<RemoteExecutionRecord>, AbortController>();
  constructor(private readonly journal: RemoteExecutionJournal, private readonly hosts: RemoteHostRepository,
    private readonly connections: RemoteConnectionManager, private readonly scheduler: RemoteOperationScheduler,
    private readonly ownerId: string) {}

  prepare(scope: Scope, executionId: string, clientInstanceId: string): RemoteReconciliationPreview {
    const record = this.owned(scope, executionId);
    if (!RECONCILABLE.has(record.state)) throw new RemoteHostError("revision_conflict", "Only unresolved executions can be reconciled.");
    this.currentHost(record);
    for (const [id, ticket] of this.tickets) if (ticket.preview.expiresAt <= Date.now()) this.tickets.delete(id);
    if (this.tickets.size >= MAX_TICKETS) throw new RemoteHostError("storage_busy", "Too many recovery confirmations are pending.");
    const evidence = this.journal.recoveryEvidence(executionId);
    const preview: RemoteReconciliationPreview = { reconciliationId: randomUUID(), executionId, display: record.display,
      paths: [...new Set([record.remotePath, record.stagingPath, record.backupPath, record.receiptPath].filter((path): path is string => Boolean(path)))],
      expiresAt: Date.now() + REMOTE_HOST_LIMITS.challengeMs,
      canVerifyPublication: record.operation === "upload" && Boolean(evidence && record.receiptPath) };
    this.tickets.set(preview.reconciliationId, { scope: { ...scope }, clientInstanceId, record, preview });
    return preview;
  }

  run(scope: Scope, reconciliationId: string, clientInstanceId: string): Promise<RemoteExecutionRecord> {
    const controller = new AbortController();
    const task = this.runOnce(scope, reconciliationId, clientInstanceId, controller.signal).finally(() => this.running.delete(task));
    this.running.set(task, controller);
    return task;
  }

  private async runOnce(scope: Scope, reconciliationId: string, clientInstanceId: string, canceled: AbortSignal): Promise<RemoteExecutionRecord> {
    const ticket = this.tickets.get(reconciliationId);
    if (!ticket || ticket.clientInstanceId !== clientInstanceId || ticket.scope.workspaceKey !== scope.workspaceKey || ticket.scope.sessionId !== scope.sessionId) {
      throw new RemoteHostError("permission_denied", "The recovery confirmation belongs to another window or conversation.", "authorization");
    }
    this.tickets.delete(reconciliationId);
    if (ticket.preview.expiresAt <= Date.now()) throw new RemoteHostError("approval_expired", "The read-only recovery confirmation expired.");
    const record = this.owned(scope, ticket.record.executionId);
    if (record.updatedAt !== ticket.record.updatedAt || record.state !== ticket.record.state) throw new RemoteHostError("revision_conflict", "The execution changed after the recovery preview.");
    const host = this.currentHost(record);
    const evidence = this.journal.recoveryEvidence(record.executionId);
    this.journal.update(record.executionId, [record.state], { state: "reconciling" });
    const checks: NonNullable<RemoteExecutionRecord["reconciliation"]>["checks"] = [];
    const finish = (reason: string, verified: boolean, error?: RemoteExecutionRecord["error"]) => this.journal.update(record.executionId, ["reconciling"], {
      state: verified ? "succeeded" : "needs_review", verification: verified ? "verified" : "unverified", error,
      reconciliation: { checkedAt: Date.now(), reason, checks }, ...(verified ? { uploadStage: "final_verified" as const } : {}) });
    if (!ticket.preview.paths.length) return finish("No durable remote receipt is available. The original shell command was not replayed.", false);
    const signal = AbortSignal.any([canceled, AbortSignal.timeout(REMOTE_HOST_LIMITS.commandMs)]);
    try {
      return await this.scheduler.run({ callKey: reconciliationId, endpointKey: `${remoteEndpoint(host.config)}|${host.config.username}`, write: false, signal }, async () => {
        const assertRead = () => { signal.throwIfAborted(); this.currentHost(record); };
        const lease = await this.connections.open(host, assertRead, signal);
        try {
          const files = await lease.connection.files();
          const guard = await RemotePathGuard.create(host, files);
          for (const path of ticket.preview.paths) {
            assertRead(); await guard.resolve(path, { allowMissing: true });
            const stat = await files.stat(path);
            checks.push({ path, exists: Boolean(stat), ...(stat ? { type: stat.type, size: stat.size } : {}) });
          }
          if (!evidence || record.operation !== "upload" || !record.receiptPath || !record.remotePath ||
            !["publish_intent", "published", "final_verified"].includes(record.uploadStage ?? "")) {
            return finish("The available paths cannot establish publication ownership. No remote writes were performed.", false);
          }
          await this.verifyPublication(record, evidence, files, signal);
          assertRead();
          return finish("The saved manifest, publication stage, receipt and final content match. This does not prove exactly-once execution.", true);
        } finally { lease.release(); }
      });
    } catch (error) { return finish("Read-only recovery did not establish a complete publication receipt. Review the retained paths before any new write.", false, remoteHostFailure(error)); }
  }

  async dispose(): Promise<void> {
    this.tickets.clear();
    for (const controller of this.running.values()) controller.abort();
    await Promise.allSettled(this.running.keys());
  }

  private async verifyPublication(record: RemoteExecutionRecord, evidence: RemoteRecoveryEvidence,
    files: import("@fcode/shared").RemoteSftpPort, signal: AbortSignal): Promise<void> {
    if (remoteManifestHash(evidence.manifest) !== record.manifestHash) throw new RemoteHostError("storage_corrupt", "The saved recovery manifest differs from the execution.", "storage");
    await verifyRemoteManifest(files, record.remotePath!, evidence.manifest, evidence.ifExists !== "merge", signal);
    if (evidence.ifExists === "replace" && evidence.previousExists) {
      if (!record.backupPath || (await inspectRemotePath(files, record.backupPath, signal)).digest !== evidence.previousDigest) {
        throw new RemoteHostError("verification_failed", "The original directory backup could not be verified.", "verification");
      }
    }
    const receipt = Buffer.from(JSON.stringify({ version: 1, executionId: record.executionId,
      attempt: record.attempt, manifestHash: record.manifestHash, remotePath: record.remotePath, published: true }));
    const stat = await files.stat(record.receiptPath!);
    if (!stat || stat.type !== "file" || stat.size !== receipt.length ||
      await remoteFileHash(files, record.receiptPath!, receipt.length, signal) !== createHash("sha256").update(receipt).digest("hex")) {
      throw new RemoteHostError("verification_failed", "The publication receipt is missing or does not match this execution.", "verification");
    }
  }

  private owned(scope: Scope, executionId: string): RemoteExecutionRecord {
    const record = this.journal.get(executionId);
    if (record.context.ownerId !== this.ownerId || record.context.workspaceKey !== scope.workspaceKey || record.context.sessionId !== scope.sessionId) {
      throw new RemoteHostError("permission_denied", "The execution belongs to another conversation.", "authorization");
    }
    return record;
  }
  private currentHost(record: RemoteExecutionRecord): RemoteHostRecord {
    const host = this.hosts.get(record.hostId);
    if (!host.config.enabled || host.securityRevision !== record.securityRevision ||
      remoteEndpoint(host.config) !== record.display.endpoint || host.config.username !== record.display.username ||
      this.hosts.getTrust(host.hostId)?.trustRevision !== record.trustRevision) {
      throw new RemoteHostError("target_changed", "The saved target or trust changed. Establish a new explicit context before connecting.");
    }
    return host;
  }
}
