import { randomUUID } from "node:crypto";
import { RemoteHostError, remoteHostFailure, remoteExecutionOutputArtifactId, type RemoteExecutionRecord,
  type RemoteCallContext, type RemoteHostToolName } from "@fcode/shared";
import { RemoteApprovalAuthority } from "./approvalAuthority.js";
import { RemoteExecutionJournal } from "./executionJournal.js";
import { RemoteHostRepository } from "./hostRepository.js";
import { RemoteSnapshotStore } from "./snapshotStore.js";
import { RemoteConnectionManager } from "./connectionManager.js";
import { RemoteOperationScheduler } from "./scheduler.js";
import { RemoteSnapshotUploader } from "./uploader.js";
import { RemoteExecutionOutput } from "./outputStore.js";
import { runRemoteStructuredRead } from "./structuredRead.js";
import { writeRemoteText } from "./textWriter.js";
import { RemotePathGuard } from "./remotePaths.js";
import { checkRemoteCondition } from "./uploadCommit.js";
import { inspectRemoteMetadata } from "./remoteFileEvidence.js";
import { remoteEndpoint } from "./hostCatalog.js";
import { remoteRecoveryEvidence } from "./recoveryEvidence.js";
import { resolveRemoteRetry } from "./retryPolicy.js";
import type { RegisteredRemoteCall } from "./invocationRegistry.js";
import type { RemotePreparedCall, RemotePreparedTarget, RemoteApprovalBinding } from "./preparedTypes.js";

const ACTIVE_STATES = ["queued", "dispatching", "running", "verifying", "cancel_requested"] as const;
const UNCERTAIN_STATES = ["execution_unknown", "reconciling", "needs_review"];
interface ExecutionPermit {
  prepared: RemotePreparedCall; target: RemotePreparedTarget; approval: RemoteApprovalBinding;
  controller: AbortController; releaseSource?: () => void;
}

export class RemoteExecutionCoordinator {
  private readonly permits = new Map<string, ExecutionPermit>();
  private readonly running = new Set<Promise<void>>();
  private readonly uploader: RemoteSnapshotUploader;
  constructor(private readonly authority: RemoteApprovalAuthority, private readonly journal: RemoteExecutionJournal,
    private readonly hosts: RemoteHostRepository, private readonly sources: RemoteSnapshotStore,
    private readonly connections: RemoteConnectionManager, private readonly scheduler: RemoteOperationScheduler,
    private readonly outputRoot: string, private readonly assertPluginAvailable: (context: RemoteCallContext) => void) {
    this.uploader = new RemoteSnapshotUploader(sources);
    this.journal.recoverInterrupted();
  }

  dispatch(call: RegisteredRemoteCall, preparedCallId: string): RemoteExecutionRecord[] {
    const requestId = typeof call.input.requestId === "string" ? call.input.requestId : call.context.toolCallId;
    const requestKey = JSON.stringify([call.context.ownerId, call.context.workspaceKey, call.context.sessionId, call.tool, requestId]);
    const { prepared, approval } = this.authority.authorized(call, preparedCallId);
    const previous = this.journal.findRequest(requestKey, call.inputDigest);
    if (previous) { this.authority.consumed(preparedCallId); return previous.map((id) => this.journal.get(id)); }
    if (prepared.source && this.sources.get(prepared.source.sourceId).availability !== "ready") {
      throw new RemoteHostError("source_not_found", "The upload source was removed or expired before acceptance.");
    }
    const now = Date.now();
    for (const target of prepared.targets) resolveRemoteRetry(this.journal, call.context, prepared.operation, target.host, target.retryOf, requestId);
    const records: RemoteExecutionRecord[] = prepared.targets.map((target) => ({
      executionId: randomUUID(), attempt: (target.retryOf?.attempt ?? 0) + 1, ...(target.retryOf ? { retryOf: target.retryOf } : {}), context: { ...call.context }, hostId: target.host.hostId,
      securityRevision: target.host.securityRevision, trustRevision: target.trustRevision,
      display: { name: target.host.config.name, endpoint: remoteEndpoint(target.host.config), username: target.host.config.username },
      operation: prepared.operation, requestId, approvalId: approval.approvalId, operationDigest: prepared.operationDigest,
      state: "queued", createdAt: now, updatedAt: now, dispatchExpiresAt: approval.dispatchExpiresAt,
      outputBytes: 0, outputTruncated: false,
      ...(prepared.source ? { sourceId: prepared.source.sourceId, snapshotId: prepared.source.snapshotId,
        manifestHash: prepared.effectiveManifestHash } : {}), ...(target.path ? { remotePath: target.path } : {}),
    }));
    this.journal.accept({ requestKey, inputDigest: call.inputDigest, approvalId: approval.approvalId,
      approvalEvidence: { ...approval, context: call.context, operation: prepared.operation,
        targets: records.map((record) => ({ hostId: record.hostId, securityRevision: record.securityRevision, trustRevision: record.trustRevision })),
        recovery: prepared.targets.map((target) => remoteRecoveryEvidence(prepared, target)).filter((value) => value !== null) }, executions: records });
    for (const record of records) this.permits.set(record.executionId, {
      prepared, target: prepared.targets.find((target) => target.host.hostId === record.hostId)!, approval,
      controller: new AbortController(), ...(record.sourceId ? { releaseSource: this.sources.retain(record.sourceId) } : {}),
    });
    this.authority.consumed(preparedCallId);
    const launch = this.launch(records, prepared.stopOnFailure).finally(() => this.running.delete(launch));
    this.running.add(launch);
    // Errors are persisted per execution; this guard prevents an unexpected scheduler failure becoming unhandled.
    void launch.catch(() => {});
    return records;
  }

  getOwned(context: RemoteCallContext, ids: string[]): RemoteExecutionRecord[] {
    return ids.map((id) => {
      const record = this.journal.get(id);
      if (record.context.ownerId !== context.ownerId || record.context.workspaceKey !== context.workspaceKey || record.context.sessionId !== context.sessionId) {
        throw new RemoteHostError("permission_denied", "This execution belongs to another conversation.", "authorization");
      }
      return record;
    });
  }

  cancelOwned(context: RemoteCallContext, ids: string[], reason: string): RemoteExecutionRecord[] {
    const records = this.getOwned(context, ids);
    for (const record of records) this.cancel(record.executionId, reason);
    return records.map((record) => this.journal.get(record.executionId));
  }
  cancelAuthorizations(ids: string[]): void {
    for (const [id, permit] of this.permits) if (permit.approval.sessionAuthorizationIds?.some(grantId => ids.includes(grantId))) this.cancel(id, "session_authorization_revoked");
  }
  cancelSession(clientInstanceId: string, sessionId: string, reason: string): void {
    for (const record of this.journal.list(sessionId)) if (record.context.clientInstanceId === clientInstanceId) this.cancel(record.executionId, reason);
  }
  cancelTurn(clientInstanceId: string, sessionId: string, turnId: string, reason: string): void {
    for (const record of this.journal.list(sessionId)) if (record.context.clientInstanceId === clientInstanceId && record.context.turnId === turnId) this.cancel(record.executionId, reason);
  }
  revokeClient(clientInstanceId: string, reason = "client_exited"): void {
    for (const record of this.journal.list()) if (record.context.clientInstanceId === clientInstanceId) this.cancel(record.executionId, reason);
  }
  revokeHost(hostId: string): void {
    for (const record of this.journal.list()) if (record.hostId === hostId) this.cancel(record.executionId, "host_revoked");
  }
  async dispose(): Promise<void> {
    for (const id of this.permits.keys()) this.cancel(id, "broker_stopped");
    await Promise.allSettled(this.running);
  }

  private cancel(executionId: string, reason: string): void {
    const record = this.journal.get(executionId);
    if (!(ACTIVE_STATES as readonly string[]).includes(record.state)) return;
    const next = record.state === "queued" ? "canceled" : "cancel_requested";
    this.journal.update(executionId, [record.state], { state: next, cancelReason: reason });
    this.permits.get(executionId)?.controller.abort(new RemoteHostError("canceled", "The execution was canceled.", "execution"));
  }

  private async launch(records: RemoteExecutionRecord[], serial: boolean): Promise<void> {
    if (!serial) { await Promise.all(records.map((record) => this.schedule(record))); return; }
    let failed = false;
    for (const record of records) {
      if (failed) this.cancel(record.executionId, "previous_target_failed");
      await this.schedule(record);
      if (this.journal.get(record.executionId).state !== "succeeded") failed = true;
    }
  }
  private async schedule(record: RemoteExecutionRecord): Promise<void> {
    const permit = this.permits.get(record.executionId)!;
    try {
      await this.scheduler.run({ callKey: permit.prepared.call.callId, endpointKey: this.endpointKey(permit.target),
        write: this.isWrite(record.operation), signal: permit.controller.signal }, () => this.run(record.executionId, permit));
    } catch (error) { this.fail(record.executionId, error); }
    finally { permit.releaseSource?.(); this.permits.delete(record.executionId); }
  }

  private async run(id: string, permit: ExecutionPermit): Promise<void> {
    const { prepared, target } = permit;
    const deadlineAt = Date.now() + prepared.timeoutMs;
    const signal = AbortSignal.any([permit.controller.signal, AbortSignal.timeout(prepared.timeoutMs)]);
    const assertPermit = () => {
      signal.throwIfAborted(); this.authority.assertSessionAuthorization(permit.approval); this.assertPluginAvailable(prepared.call.context);
      if (!(ACTIVE_STATES as readonly string[]).includes(this.journal.get(id).state)) throw new RemoteHostError("canceled", "The persisted execution permit is no longer active.", "authorization");
      const host = this.hosts.get(target.host.hostId);
      if (!host.config.enabled || host.securityRevision !== target.host.securityRevision ||
        (this.hosts.getTrust(host.hostId)?.trustRevision ?? 0) !== target.trustRevision) throw new RemoteHostError("target_changed", "The approved host changed before dispatch.");
    };
    assertPermit();
    if (target.error) throw new RemoteHostError(target.error.code, target.error.message, target.error.stage);
    if (Date.now() >= permit.approval.dispatchExpiresAt) throw new RemoteHostError("approval_expired", "The dispatch approval expired while queued.");
    this.checkUnknownWrites(permit);
    if (prepared.source) await this.sources.validate(prepared.source.sourceId, true);
    const lease = await this.connections.acquire(prepared.call.context, target.host, assertPermit, signal);
    let output: RemoteExecutionOutput | undefined;
    try {
      const files = prepared.operation === "exec" ? undefined : await lease.connection.files();
      if (target.path) {
        const guard = await RemotePathGuard.create(target.host, files!);
        await guard.resolve(target.path, { allowMissing: this.isWrite(prepared.operation), siblingRequired: this.isWrite(prepared.operation) });
        if (this.isWrite(prepared.operation)) await checkRemoteCondition(files!, target, signal);
        else if ((await inspectRemoteMetadata(files!, target.path)).digest !== target.condition!.digest) throw new RemoteHostError("preflight_changed", "The structured read target changed.");
      }
      assertPermit();
      if (Date.now() >= permit.approval.dispatchExpiresAt) throw new RemoteHostError("approval_expired", "The dispatch approval expired during validation.");
      const start = Date.now();
      // Persist intent before opening a command channel or writing any remote byte.
      this.journal.update(id, ["queued"], { state: "dispatching", startedAt: start, deadlineAt });
      const patch = (value: Partial<RemoteExecutionRecord>) => this.journal.update(id, ACTIVE_STATES, value);
      patch({ state: "running" });
      if (prepared.operation === "exec") {
        output = await RemoteExecutionOutput.create(this.outputRoot, id, this.journal.get(id).attempt, [...lease.redactionValues,
          ...Object.values(target.command?.env ?? {}), ...Object.values(target.verify?.env ?? {})]);
        patch({ outputArtifactId: remoteExecutionOutputArtifactId(id, this.journal.get(id).attempt) });
        const result = await lease.connection.exec(target.command!, { signal, onOutput: output.append });
        if (result.exitCode === null && !result.signal) throw new RemoteHostError("execution_unknown", "The server returned no command exit code.", "execution");
        patch({ ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}), ...(result.signal ? { signal: result.signal } : {}) });
        if (result.exitCode !== 0 || result.signal) throw new RemoteHostError("execution_failed", "The approved command did not exit successfully.", "execution");
        if (target.verify) {
          signal.throwIfAborted(); patch({ state: "verifying" });
          const verified = await lease.connection.exec(target.verify, { signal, onOutput: output.append });
          if (verified.exitCode === null && !verified.signal) {
            patch({ verification: "unverified" }); throw new RemoteHostError("execution_unknown", "The verification command returned no exit code.", "verification");
          }
          if (verified.exitCode !== 0 || verified.signal) {
            patch({ verification: "failed" }); throw new RemoteHostError("verification_failed", "The approved verification command did not succeed.", "verification");
          }
          patch({ verification: "verified" });
        } else patch({ verification: "not_requested" });
      } else if (prepared.operation === "upload") await this.uploader.run(prepared, target, this.journal.get(id), files!, patch, signal);
      else if (prepared.operation === "write_file") await writeRemoteText(prepared, target, this.journal.get(id), files!, patch, signal);
      else patch({ result: await runRemoteStructuredRead(prepared, target, files!, signal) });
      if (output) { const { summary, ...stats } = output.finish(); patch({ ...stats, result: { summary } }); output = undefined; }
      patch({ state: "succeeded" });
    } finally {
      try {
        if (output) { const { summary, ...stats } = output.finish(); this.journal.update(id, ACTIVE_STATES, { ...stats, result: { summary } }); }
      } finally { lease.release(); }
    }
  }

  private fail(id: string, error: unknown): void {
    const record = this.journal.get(id);
    if (!(ACTIVE_STATES as readonly string[]).includes(record.state)) return;
    const failure = remoteHostFailure(error);
    const dispatched = record.state !== "queued";
    const unconfirmedCommand = record.operation === "exec" && failure.code !== "execution_failed" && failure.code !== "verification_failed";
    const uncertain = dispatched && (unconfirmedCommand || failure.code === "execution_unknown" || failure.code === "connection_failed" ||
      failure.code === "connection_timeout" || record.uploadStage === "backup_intent" || record.uploadStage === "backed_up" ||
      record.uploadStage === "publish_intent" || record.uploadStage === "published" || failure.code === "canceled");
    const state = uncertain ? "execution_unknown" : failure.code === "canceled" ? "canceled" : "failed";
    this.journal.update(id, [record.state], { state, error: failure,
      ...(failure.code === "hash_unverified" ? { verification: "unverified" as const } : {}) });
  }
  private checkUnknownWrites(permit: ExecutionPermit): void {
    if (!this.isWrite(permit.prepared.operation)) return;
    const writes = this.journal.list().filter((record) => this.isWrite(record.operation) &&
      `${record.display.endpoint}|${record.display.username}` === this.endpointKey(permit.target));
    const orphaned = writes.some((record) => record.state !== "queued" && (ACTIVE_STATES as readonly string[]).includes(record.state) &&
      !this.permits.has(record.executionId));
    if (orphaned) {
      throw new RemoteHostError("execution_unknown", "An earlier write has an unsaved outcome. Restart FCode, review that execution, and approve any further write separately.", "authorization");
    }
    const unresolved = writes.filter((record) => UNCERTAIN_STATES.includes(record.state));
    if (unresolved.some((record) => !permit.approval.acceptedUnknownExecutionIds.includes(record.executionId))) {
      throw new RemoteHostError("execution_unknown", "A prior write to this endpoint remains unresolved. Review it before approving another write.", "authorization");
    }
  }
  private endpointKey(target: RemotePreparedTarget): string { return `${remoteEndpoint(target.host.config)}|${target.host.config.username}`; }
  private isWrite(tool: RemoteHostToolName | string): boolean { return tool === "exec" || tool === "write_file" || tool === "upload"; }
}
