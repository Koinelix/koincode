import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { REMOTE_HOST_LIMITS, RemoteHostError, remoteHostToolSchemas, remoteHostFailure,
  type RemoteCallContext, type RemoteOperation, type RemoteSelection } from "@fcode/shared";
import { RemoteHostRepository } from "./hostRepository.js";
import { RemoteConnectionManager } from "./connectionManager.js";
import { RemoteOperationScheduler } from "./scheduler.js";
import { RemoteSnapshotStore } from "./snapshotStore.js";
import { RemotePathGuard } from "./remotePaths.js";
import { inspectRemotePath, inspectRemoteMetadata } from "./remoteFileEvidence.js";
import { filterRemoteManifest, remoteManifestHash } from "./snapshotManifest.js";
import { remoteInputDigest } from "./canonicalInput.js";
import { remoteEndpoint } from "./hostCatalog.js";
import { pathInside } from "./snapshotFiles.js";
import type { RegisteredRemoteCall } from "./invocationRegistry.js";
import type { RemotePreparedCall, RemotePreparedTarget } from "./preparedTypes.js";
import { resolveRemoteRetry, type RemoteRetryReference } from "./retryPolicy.js";
import type { RemoteExecutionJournal } from "./executionJournal.js";

export class RemoteCallPreparer {
  constructor(private readonly hosts: RemoteHostRepository, private readonly connections: RemoteConnectionManager,
    private readonly scheduler: RemoteOperationScheduler, private readonly sources: RemoteSnapshotStore,
    private readonly workspaceRoot: (context: RemoteCallContext) => string | undefined, private readonly journal: RemoteExecutionJournal) {}

  workspaceSourcePath(context: RemoteCallContext, input: string): string {
    const root = this.workspaceRoot(context);
    if (!root) throw new RemoteHostError("remote_runtime_not_supported", "A trusted local workspace is required.");
    const path = resolve(root, input);
    if (!pathInside(resolve(root), path)) throw new RemoteHostError("path_not_allowed", "The upload source must be inside the authorized workspace.");
    return path;
  }

  /** Both remote preflight and local source read must be authorized before this method runs. */
  async prepare(call: RegisteredRemoteCall, selection: RemoteSelection, assertReadAuthorized: () => void,
    localReadAuthorized: boolean, signal?: AbortSignal): Promise<RemotePreparedCall> {
    assertReadAuthorized(); signal?.throwIfAborted();
    const operation = call.tool as RemoteOperation;
    const prepared: RemotePreparedCall = { preparedCallId: randomUUID(), call: structuredClone(call), operation,
      input: structuredClone(call.input), operationDigest: call.inputDigest, preflightDigest: "",
      targets: [], timeoutMs: REMOTE_HOST_LIMITS.commandMs, stopOnFailure: false, preparedAt: Date.now() };
    if (operation === "upload") await this.source(prepared, selection, localReadAuthorized, signal);
    if (operation === "exec") {
      const input = remoteHostToolSchemas.exec.parse(call.input);
      prepared.timeoutMs = input.timeoutMs; prepared.stopOnFailure = input.stopOnFailure;
    }
    const inputTargets = "targets" in call.input ? call.input.targets as Array<{ hostId: string; retryOf?: RemoteRetryReference }>
      : [{ hostId: String(call.input.hostId), retryOf: call.input.retryOf as RemoteRetryReference | undefined }];
    try {
      // Preflight is bounded and serial within a call; global scheduling still applies across calls.
      for (const inputTarget of inputTargets) {
        const host = this.hosts.get(inputTarget.hostId);
        const selected = selection.targets.find((item) => item.hostId === host.hostId);
        if (!selected) throw new RemoteHostError("permission_denied", "A target is not in this message's fixed selection.", "authorization");
        const target: RemotePreparedTarget = { host, trustRevision: selected.trustRevision,
          retryOf: resolveRemoteRetry(this.journal, call.context, operation, host, inputTarget.retryOf, String(call.input.requestId ?? call.context.toolCallId)) };
        try { await this.scheduler.run({ callKey: call.callId, endpointKey: `${remoteEndpoint(host.config)}|${host.config.username}`,
          write: false, signal }, async () => {
          assertReadAuthorized();
          const lease = await this.connections.acquire(call.context, host, assertReadAuthorized, signal);
          try {
            if (operation === "exec") {
              const command = remoteHostToolSchemas.exec.parse(call.input).targets.find((item) => item.hostId === host.hostId)!;
              const cwd = command.cwd ?? host.config.defaultCwd;
              target.command = { command: command.command, ...(cwd ? { cwd } : {}), ...(command.env ? { env: command.env } : {}) };
              if (command.verify) {
                const verifyCwd = command.verify.cwd ?? host.config.defaultCwd;
                target.verify = { command: command.verify.command, ...(verifyCwd ? { cwd: verifyCwd } : {}),
                  ...(command.verify.env ? { env: command.verify.env } : {}) };
              }
              return;
            }
            const files = await lease.connection.files();
            {
              const guard = await RemotePathGuard.create(host, files);
              const raw = operation === "upload" ? remoteHostToolSchemas.upload.parse(call.input).targets.find((item) => item.hostId === host.hostId)!
                : operation === "write_file" ? remoteHostToolSchemas.write_file.parse(call.input).targets.find((item) => item.hostId === host.hostId)!
                : call.input as { path: string };
              const requested = "remotePath" in raw ? raw.remotePath : raw.path;
              target.path = await guard.resolve(requested, { allowMissing: operation === "upload" || operation === "write_file",
                siblingRequired: operation === "upload" || operation === "write_file" });
              target.condition = operation === "read_file" || operation === "list_directory"
                ? await inspectRemoteMetadata(files, target.path) : await inspectRemotePath(files, target.path, signal);
              if (operation === "list_directory" && target.condition.stat?.type !== "directory" ||
                operation === "read_file" && target.condition.stat?.type !== "file") {
                throw new RemoteHostError("path_not_allowed", "The remote path has the wrong type.");
              }
              if (operation === "upload" || operation === "write_file") {
                target.ifExists = "ifExists" in raw ? raw.ifExists : "fail";
                if ("expectedHash" in raw) target.expectedHash = raw.expectedHash as string | null;
                const kind = prepared.source?.kind ?? "file";
                if (kind === "file" && (target.ifExists === "merge" || target.ifExists === "replace") || kind === "directory" && target.ifExists === "overwrite") {
                  throw new RemoteHostError("invalid_request", "The conflict policy is not valid for this source type.");
                }
                if (target.condition.stat && target.condition.stat.type !== kind) throw new RemoteHostError("destination_exists", "The destination has a different type.");
                if (target.condition.stat && target.ifExists === "fail") throw new RemoteHostError("destination_exists", "The destination already exists.");
                if (operation === "write_file") {
                  const currentHash = target.condition.entries[0]?.sha256 ?? null;
                  if (currentHash !== target.expectedHash) throw new RemoteHostError("file_conflict", "The destination differs from the expected content.");
                }
                const parent = target.path.slice(0, target.path.lastIndexOf("/")) || "/";
                if ((await files.stat(parent))?.type !== "directory") throw new RemoteHostError("path_not_allowed", "The destination parent must already exist.");
                target.availableBytes = await files.availableBytes(parent);
                const bytes = prepared.entries?.reduce((total, entry) => total + entry.size, 0) ?? Buffer.byteLength(String(call.input.content));
                if (target.availableBytes !== null && target.availableBytes < bytes) throw new RemoteHostError("insufficient_space", "The destination has insufficient available space.");
                const overwrite = target.condition.entries.filter((item) => item.stat.type === "file" &&
                  (kind === "file" || prepared.entries?.some((entry) => entry.relativePath === item.path && entry.type === "file")));
                target.overwriteCount = overwrite.length; target.overwriteExamples = overwrite.slice(0, 10).map((item) => item.path);
              }
            }
          } finally { lease.release(); }
        }); } catch (error) { target.error = remoteHostFailure(error); }
        prepared.targets.push(target);
      }
      if (prepared.targets.every((target) => target.error)) {
        const failure = prepared.targets[0]!.error!; throw new RemoteHostError(failure.code, failure.message, failure.stage);
      }
      prepared.preflightDigest = remoteInputDigest({ version: 1, targets: prepared.targets,
        effectiveManifestHash: prepared.effectiveManifestHash ?? null });
      return prepared;
    } catch (error) { prepared.releaseSource?.(); throw error; }
  }

  private async source(prepared: RemotePreparedCall, selection: RemoteSelection, localReadAuthorized: boolean, signal?: AbortSignal): Promise<void> {
    const input = remoteHostToolSchemas.upload.parse(prepared.input);
    let sourceId: string;
    if (input.source.kind === "source_id") {
      sourceId = input.source.sourceId;
      if (!selection.sourceIds.includes(sourceId)) throw new RemoteHostError("permission_denied", "This source is not in the message selection.", "authorization");
    } else {
      if (!localReadAuthorized) throw new RemoteHostError("approval_required", "Approve the workspace file read before preparing this upload.", "authorization");
      const root = this.workspaceRoot(prepared.call.context);
      if (!root) throw new RemoteHostError("remote_runtime_not_supported", "A trusted local workspace is required.");
      const source = await this.sources.freeze({ path: this.workspaceSourcePath(prepared.call.context, input.source.path), origin: "workspace_path", workspaceRoot: root,
        ownerId: selection.ownerId, workspaceKey: selection.workspaceKey, binding: selection.binding,
        callId: prepared.call.callId, signal });
      sourceId = source.sourceId;
    }
    prepared.source = await this.sources.validate(sourceId);
    if (prepared.source.ownerId !== selection.ownerId || prepared.source.workspaceKey !== selection.workspaceKey ||
      prepared.source.callId && prepared.source.callId !== prepared.call.callId) throw new RemoteHostError("permission_denied", "The upload source belongs to a different call.", "authorization");
    prepared.entries = filterRemoteManifest(prepared.source.entries, input.exclude);
    if (!prepared.entries.length) throw new RemoteHostError("source_empty", "The effective upload manifest is empty.");
    prepared.effectiveManifestHash = remoteManifestHash(prepared.entries);
    prepared.timeoutMs = REMOTE_HOST_LIMITS.uploadMs;
    prepared.releaseSource = this.sources.retain(sourceId);
  }
}
