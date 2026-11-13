import { publicRemoteSource } from "./sourceSummary.js";
export { publicRemoteSource } from "./sourceSummary.js";
import { randomUUID } from "node:crypto";
import { join, isAbsolute } from "node:path";
import { RemoteHostError, REMOTE_HOST_PROTOCOL_VERSION, remoteHostManagementSchemas,
  remoteHostFailure, remoteHostExecutionSupport, type RemoteCallContext,
  type RemoteSshTransportPort } from "@fcode/shared";
import { RemoteHostDatabase } from "./database.js";
import { RemoteHostRepository } from "./hostRepository.js";
import { RemoteSecretVault, type RemoteSystemSecretPort } from "./secretVault.js";
import { RemoteHostCatalog, remoteEndpoint } from "./hostCatalog.js";
import { RemoteSnapshotStore } from "./snapshotStore.js";
import { RemoteTrustAuthority } from "./trustAuthority.js";
import { RemoteConnectionManager } from "./connectionManager.js";
import { RemoteSelectionStore } from "./selectionStore.js";
import { RemoteInvocationRegistry } from "./invocationRegistry.js";
import { RemoteOperationScheduler } from "./scheduler.js";
import { RemoteCallPreparer } from "./preparer.js";
import { RemoteApprovalAuthority } from "./approvalAuthority.js";
import { RemoteExecutionJournal } from "./executionJournal.js";
import { RemoteExecutionCoordinator } from "./executionCoordinator.js";
import { RemoteExecutionReconciler } from "./reconciler.js";
import { RemoteManagementOperations } from "./managementOperations.js";
import { RemoteExecutionDetails } from "./executionDetails.js";


export interface RemoteHostRuntimeOptions {
  root: string;
  systemSecrets: RemoteSystemSecretPort;
  transport: RemoteSshTransportPort;
  workspaceRoot(context: RemoteCallContext): string | undefined;
  assertPluginAvailable(context: RemoteCallContext): void;
}

/** The utility-process broker owns the only runtime for one local data root. */
export class RemoteHostRuntime {
  readonly hosts: RemoteHostRepository;
  readonly vault: RemoteSecretVault;
  readonly catalog: RemoteHostCatalog;
  readonly sources: RemoteSnapshotStore;
  readonly trust: RemoteTrustAuthority;
  readonly connections: RemoteConnectionManager;
  readonly selections: RemoteSelectionStore;
  readonly registry: RemoteInvocationRegistry;
  readonly scheduler: RemoteOperationScheduler;
  readonly authority: RemoteApprovalAuthority;
  readonly journal: RemoteExecutionJournal;
  readonly coordinator: RemoteExecutionCoordinator;
  readonly reconciler: RemoteExecutionReconciler;
  readonly managementOperations = new RemoteManagementOperations();
  readonly executionDetails: RemoteExecutionDetails;

  private constructor(readonly database: RemoteHostDatabase, private readonly options: RemoteHostRuntimeOptions) {
    this.hosts = new RemoteHostRepository(database);
    this.vault = new RemoteSecretVault(options.systemSecrets);
    const revoke = (id: string) => { this.authority?.revokeHost(id); this.coordinator?.revokeHost(id); this.connections?.revokeHost(id); };
    this.catalog = new RemoteHostCatalog(this.hosts, this.vault, revoke);
    this.sources = new RemoteSnapshotStore(database, join(options.root, "snapshots"));
    this.trust = new RemoteTrustAuthority(this.hosts, revoke);
    this.connections = new RemoteConnectionManager(this.hosts, this.vault, this.trust, options.transport);
    this.selections = new RemoteSelectionStore(database, this.hosts, this.sources);
    this.registry = new RemoteInvocationRegistry(this.selections);
    this.scheduler = new RemoteOperationScheduler();
    this.journal = new RemoteExecutionJournal(database);
    this.executionDetails = new RemoteExecutionDetails(this.journal, join(options.root, "output"), database.ownerId);
    const preparer = new RemoteCallPreparer(this.hosts, this.connections, this.scheduler, this.sources, options.workspaceRoot, this.journal);
    this.authority = new RemoteApprovalAuthority(this.registry, this.selections, this.hosts, preparer, options.assertPluginAvailable);
    this.coordinator = new RemoteExecutionCoordinator(this.authority, this.journal, this.hosts, this.sources,
      this.connections, this.scheduler, join(options.root, "output"), options.assertPluginAvailable);
    this.reconciler = new RemoteExecutionReconciler(this.journal, this.hosts, this.connections, this.scheduler, database.ownerId);
  }

  static async create(options: RemoteHostRuntimeOptions): Promise<RemoteHostRuntime> {
    const database = await RemoteHostDatabase.open(options.root);
    try { const runtime = new RemoteHostRuntime(database, options); await runtime.sources.initialize(); return runtime; }
    catch (error) { database.close(); throw error; }
  }

  /** Only Main's authenticated management dispatcher may invoke these handlers. */
  async manage(method: string, raw: unknown, clientInstanceId: string, selectedPath?: string, windowId?: string): Promise<unknown> {
    if (method === "getCapabilities") {
      remoteHostManagementSchemas.getCapabilities.parse(raw);
      const execution = remoteHostExecutionSupport(process.platform);
      return { protocolVersion: REMOTE_HOST_PROTOCOL_VERSION, ownerId: this.database.ownerId,
        brokerGeneration: this.registry.generation, executionAvailable: execution.available,
        ...(execution.unavailableReason ? { executionUnavailableReason: execution.unavailableReason } : {}),
        pluginAvailable: false, canSelectFilePath: true, secretStorage: await this.options.systemSecrets.getStatus() };
    }
    if (method === "listHosts") return this.catalog.list(remoteHostManagementSchemas.listHosts.parse(raw));
    if (method === "saveHost") return this.catalog.save(remoteHostManagementSchemas.saveHost.parse(raw));
    if (method === "acceptHostKey") {
      const input = remoteHostManagementSchemas.acceptHostKey.parse(raw);
      const trust = this.trust.accept(input.challengeId, input.action);
      return { hostId: trust.hostId, trustRevision: trust.trustRevision };
    }
    if (method === "deleteHosts") {
      const input = remoteHostManagementSchemas.deleteHosts.parse(raw);
      return input.targets.map((target) => {
        try { this.catalog.remove(target.hostId, target.expectedRevision); this.trust.forget(target.hostId); return { hostId: target.hostId, success: true }; }
        catch (error) { return { hostId: target.hostId, success: false, error: remoteHostFailure(error) }; }
      });
    }
    if (method === "updateHosts") {
      const input = remoteHostManagementSchemas.updateHosts.parse(raw);
      const results: unknown[] = [];
      for (const target of input.targets) {
        try {
          const previous = this.hosts.get(target.hostId);
          const host = await this.catalog.save({ hostId: target.hostId, expectedRevision: target.expectedRevision,
            requestId: `${input.requestId}:${target.hostId}`, config: { ...previous.config, ...input.patch }, secret: { intent: "keep" } });
          results.push({ hostId: target.hostId, success: true, host });
        } catch (error) { results.push({ hostId: target.hostId, success: false, error: remoteHostFailure(error) }); }
      }
      return results;
    }
    if (method === "testConnections") {
      const input = remoteHostManagementSchemas.testConnections.parse(raw);
      return this.managementOperations.run(clientInstanceId, input.operationId, async (signal) => {
        const callKey = randomUUID();
        const results = await Promise.all(input.targets.map(async (target) => {
          try {
            signal.throwIfAborted(); const host = this.hosts.get(target.hostId);
            return await this.scheduler.run({ callKey, endpointKey: `${remoteEndpoint(host.config)}|${host.config.username}`, write: false, signal },
              () => this.connections.test(target.hostId, target.securityRevision, signal));
          } catch (error) { return { hostId: target.hostId, success: false, checkedAt: Date.now(), error: remoteHostFailure(error) }; }
        }));
        signal.throwIfAborted(); return results;
      });
    }
    if (method === "chooseUploadSource") {
      const input = remoteHostManagementSchemas.chooseUploadSource.parse(raw);
      if (!selectedPath) return null;
      return this.managementOperations.run(clientInstanceId, input.operationId, async (signal) => {
        const source = await this.sources.freeze({ path: selectedPath, origin: "picker", ownerId: this.database.ownerId,
          workspaceKey: input.workspaceKey, binding: input.binding, signal });
        if (signal.aborted) { await this.sources.expire(source.sourceId); signal.throwIfAborted(); }
        return publicRemoteSource(source);
      });
    }
    if (method === "addUploadAttachments") {
      const input = remoteHostManagementSchemas.addUploadAttachments.parse(raw);
      return this.managementOperations.run(clientInstanceId, input.operationId, async (signal) => {
        const sources = []; const failures = [];
        try {
          for (const path of input.paths) {
            signal.throwIfAborted();
            try {
              if (!isAbsolute(path)) throw new RemoteHostError("path_not_allowed", "An upload attachment requires its actual absolute local path.");
              const source = await this.sources.freeze({ path, origin: "attachment", ownerId: this.database.ownerId,
                workspaceKey: input.workspaceKey, binding: input.binding, signal });
              sources.push(publicRemoteSource(source));
            } catch (error) {
              if (error instanceof RemoteHostError && error.stage === "storage") throw error;
              signal.throwIfAborted(); failures.push({ path, error: remoteHostFailure(error) });
            }
          }
          signal.throwIfAborted(); return { sources, failures };
        } catch (error) {
          await Promise.all(sources.map((source) => this.sources.expire(source.sourceId))); throw error;
        }
      });
    }
    if (method === "removeUploadSource") {
      const input = remoteHostManagementSchemas.removeUploadSource.parse(raw);
      this.sources.assertOwned(input.sourceId, { ...input, ownerId: this.database.ownerId });
      await this.sources.expire(input.sourceId); return { removed: true };
    }
    if (method === "listUploadSources") {
      const input = remoteHostManagementSchemas.listUploadSources.parse(raw);
      const page = this.sources.listOwned({ ...input, ownerId: this.database.ownerId });
      return { ...page, items: page.items.map((source) => ({ ...publicRemoteSource(source), originalPath: source.originalPath })) };
    }
    if (method === "confirmUploadSource") {
      const input = remoteHostManagementSchemas.confirmUploadSource.parse(raw);
      return this.managementOperations.run(clientInstanceId, input.operationId, async (signal) =>
        publicRemoteSource(await this.sources.confirm({ ...input, ownerId: this.database.ownerId, signal })));
    }
    if (method === "cancelManagementOperation") {
      const input = remoteHostManagementSchemas.cancelManagementOperation.parse(raw);
      return { cancelRequested: this.managementOperations.cancel(clientInstanceId, input.operationId) };
    }
    if (method === "bindMessageSelection") {
      const input = remoteHostManagementSchemas.bindMessageSelection.parse(raw);
      return this.selections.create({ ...input, ownerId: this.database.ownerId });
    }
    if (method === "getSessionAuthorization" || method === "revokeSessionAuthorization") {
      if (!windowId) throw new RemoteHostError("permission_denied", "Session authorization management requires a Main-owned window.", "authorization");
      const input = remoteHostManagementSchemas[method].parse(raw);
      if (method === "getSessionAuthorization") return this.authority.sessions.status(windowId, input.workspaceKey, input.sessionId);
      const ids = this.authority.sessions.revokeSession(windowId, input.workspaceKey, input.sessionId);
      this.authority.cancelAuthorizationPreparations(ids); this.coordinator.cancelAuthorizations(ids); return { revoked: ids.length > 0 };
    }
    if (method === "listExecutions") {
      const input = remoteHostManagementSchemas.listExecutions.parse(raw);
      const page = this.journal.page(input); const details = await this.executionDetails.access(page.items);
      return { ...page, items: details.records, maintenancePending: details.maintenancePending,
        liveRemoteTurn: this.registry.hasSelectedTurn(input.workspaceKey, input.sessionId) };
    }
    if (method === "readExecutionOutput") return this.executionDetails.read(remoteHostManagementSchemas.readExecutionOutput.parse(raw));
    if (method === "cancelExecution") {
      const input = remoteHostManagementSchemas.cancelExecution.parse(raw);
      // The management context grants cancellation of existing owned records, never new execution.
      return this.coordinator.cancelOwned({ ownerId: this.database.ownerId, clientInstanceId, workspaceKey: input.workspaceKey,
        sessionId: input.sessionId, agentGeneration: "management", brokerGeneration: this.registry.generation,
        traceId: randomUUID(), messageId: "management", turnId: "management", toolCallId: input.requestId,
        runtimeScope: "main" }, input.executionIds, "user_canceled");
    }
    if (method === "prepareReconciliation") {
      const input = remoteHostManagementSchemas.prepareReconciliation.parse(raw);
      return this.reconciler.prepare(input, input.executionId, clientInstanceId);
    }
    if (method === "reconcileExecution") {
      const input = remoteHostManagementSchemas.reconcileExecution.parse(raw);
      return this.reconciler.run(input, input.reconciliationId, clientInstanceId);
    }
    throw new RemoteHostError("invalid_request", "This management operation is not supported.");
  }

  async dispose(): Promise<void> {
    const managementStopped = this.managementOperations.dispose();
    await this.executionDetails.dispose();
    await this.reconciler.dispose(); await this.coordinator.dispose(); this.authority.dispose(); this.registry.dispose();
    this.connections.dispose(); await managementStopped;
    this.scheduler.dispose(); this.vault.dispose(); this.catalog.dispose(); await this.sources.dispose(); this.database.close();
  }
}
