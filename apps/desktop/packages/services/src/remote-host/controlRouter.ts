import { remoteEndpoint } from "./hostCatalog.js";
import { RemoteHostError, remoteHostControlCommandSchema, type RemoteHostControlCommand, type RemoteCallContext } from "@fcode/shared";
import type { RemoteHostRuntime } from "./runtime.js";
import type { RemoteClientPrincipal } from "./invocationRegistry.js";
import { RemoteHostClientEndpoint } from "./clientEndpoint.js";
import { invokeRemoteHostClient, assertRemoteModelBudget } from "./clientMethods.js";
import { remoteApprovalPreview } from "./approvalPreview.js";
import { RemotePluginLifecycle } from "./pluginLifecycle.js";
import type { RemoteHostPrivateListenerFactory } from "./privateListener.js";

export interface RemoteHostMainScope { windowId: string; hostId: string }
interface AgentRegistration {
  scope: RemoteHostMainScope;
  principal: RemoteClientPrincipal;
  workspaceRoot: string;
  pluginEnabled: boolean;
  loadedPluginEnabled: boolean;
  pluginGeneration?: string;
  credential: { socket: string; token: string; protocolVersion: number };
}

/** Reachable only through Main's authenticated utility-process control port. */
export class RemoteHostControlRouter {
  private readonly agents = new Map<string, AgentRegistration>();
  private readonly plugins = new RemotePluginLifecycle((workspaceKey) => {
    for (const [id, agent] of this.agents) if (!workspaceKey || agent.principal.workspaceKey === workspaceKey) {
      this.runtime.authority.sessions.revokeWorkspace(agent.principal.workspaceKey);
      agent.pluginEnabled = false; agent.pluginGeneration = undefined; this.revokeInvocations(id, "plugin_changed");
    }
  });
  readonly endpoint: RemoteHostClientEndpoint;
  constructor(private readonly runtime: RemoteHostRuntime, privateListenerFactory?: RemoteHostPrivateListenerFactory) {
    this.endpoint = new RemoteHostClientEndpoint(async (principal, identity, method, input, signal) => {
      this.assertAvailable(principal);
      const value = await invokeRemoteHostClient(runtime, principal, identity, method, input, signal);
      assertRemoteModelBudget(value); return value;
    }, process.platform, privateListenerFactory);
  }

  assertAvailable(context: Pick<RemoteCallContext, "clientInstanceId" | "agentGeneration" | "brokerGeneration" | "workspaceKey" | "ownerId">): void {
    const agent = this.agents.get(context.clientInstanceId);
    if (!agent || !agent.loadedPluginEnabled || !agent.pluginEnabled || !this.plugins.isCurrent(agent.principal.workspaceKey, agent.pluginGeneration)) {
      throw new RemoteHostError("plugin_unavailable", "Submit a new message after verifying the enabled official Remote Host plugin for this Agent.", "authorization");
    }
    if (agent.principal.agentGeneration !== context.agentGeneration || agent.principal.brokerGeneration !== context.brokerGeneration ||
      agent.principal.workspaceKey !== context.workspaceKey || agent.principal.ownerId !== context.ownerId) {
      throw new RemoteHostError("permission_denied", "The Agent or broker generation is stale.", "authorization");
    }
  }
  workspaceRoot(context: RemoteCallContext): string | undefined {
    this.assertAvailable(context); return this.agents.get(context.clientInstanceId)?.workspaceRoot;
  }

  async control(scope: RemoteHostMainScope, raw: RemoteHostControlCommand): Promise<unknown> {
    const command = remoteHostControlCommandSchema.parse(raw);
    if (command.kind === "open-agent") return this.open(scope, command);
    if (command.kind === "begin-plugin-mutation") { this.plugins.begin(scope, command.mutationId, command.workspaceKey); return { blocked: true }; }
    if (command.kind === "end-plugin-mutation") { this.plugins.end(scope, command.mutationId); return { closed: true }; }
    const agent = this.agents.get(command.clientInstanceId);
    if (!agent) {
      if (command.kind === "revoke-agent") return { revoked: true };
      throw new RemoteHostError("runtime_protocol_mismatch", "The Remote Host runtime restarted or this Agent registration expired. Restart FCode to establish a new Agent. Review retained executions before repeating an operation.", "authorization");
    }
    if (agent.scope.hostId !== scope.hostId || agent.scope.windowId !== scope.windowId) {
      throw new RemoteHostError("permission_denied", "This Host does not own the Agent registration.", "authorization");
    }
    const principal = agent.principal;
    if (command.kind === "revoke-agent") { this.revoke(command.clientInstanceId); return { revoked: true }; }
    if (command.kind === "set-plugin") {
      // A CLI report describes its loaded entry only; fresh Host verification is a separate fact.
      agent.loadedPluginEnabled = command.enabled;
      if (!command.enabled) { agent.pluginEnabled = false; this.revokeInvocations(command.clientInstanceId, "plugin_disabled"); }
      return { enabled: agent.pluginEnabled && agent.loadedPluginEnabled };
    }
    if (command.kind === "get-plugin-generation") return { pluginGeneration: this.plugins.generation(principal.workspaceKey) };
    if (command.kind === "verify-plugin") {
      if (command.enabled && !this.plugins.isCurrent(principal.workspaceKey, command.pluginGeneration)) {
        throw new RemoteHostError("plugin_unavailable", "Plugin facts changed while being read. Submit again after the plugin change finishes.", "authorization");
      }
      agent.pluginEnabled = command.enabled; agent.pluginGeneration = command.pluginGeneration;
      if (!command.enabled) this.revokeInvocations(command.clientInstanceId, "plugin_unavailable");
      return { enabled: command.enabled };
    }
    if (command.kind === "close-session") {
      this.runtime.registry.closeSession(principal, command.sessionId);
      this.runtime.authority.revokeSession(command.clientInstanceId, command.sessionId);
      this.runtime.coordinator.cancelSession(command.clientInstanceId, command.sessionId, "session_closed");
      this.runtime.connections.revokeSession(command.clientInstanceId, command.sessionId);
      return { closed: true };
    }
    if (command.kind === "close-turn") {
      if (command.reason !== "completed") this.runtime.coordinator.cancelTurn(command.clientInstanceId, command.sessionId, command.turnId, `turn_${command.reason}`);
      this.runtime.registry.closeTurn(principal, command.sessionId, command.turnId);
      this.runtime.authority.revokeTurn(command.clientInstanceId, command.sessionId, command.turnId);
      return { closed: true };
    }
    if (command.kind === "close-call") {
      const call = this.runtime.registry.resolve(principal, command.identity);
      this.runtime.authority.invalidateCall(call.callId); this.runtime.registry.closeCall(principal, command.identity);
      return { closed: true };
    }
    if (command.kind === "register-submission") {
      if (!agent.pluginEnabled || !this.plugins.isCurrent(principal.workspaceKey, agent.pluginGeneration)) {
        throw new RemoteHostError("plugin_unavailable", "Verify current plugin facts before registering a selection.", "authorization");
      }
      this.runtime.registry.registerSubmission(principal, command.submissionId, command.selectionId); return { registered: true };
    }
    this.assertAvailable(principal);
    if (command.kind === "start-turn") {
      this.runtime.registry.startTurn(principal, command); return { registered: true };
    }
    if (command.kind === "register-call") {
      this.runtime.registry.scheduleCall(principal, { ...command.identity, tool: command.tool, trustedBuiltin: command.trustedBuiltin, input: command.input });
      return { registered: true };
    }
    if (command.kind === "rewrite-call") {
      const previous = this.runtime.registry.resolve(principal, command.identity);
      this.runtime.authority.invalidateCall(previous.callId);
      this.runtime.registry.rewriteCall(principal, command.identity, command.tool, command.input); return { rewritten: true };
    }
    if (command.kind === "start-call") { this.runtime.registry.startCall(principal, command.identity); return { started: true }; }
    const call = this.runtime.registry.resolve(principal, command.identity);
    if (command.kind === "read-request") {
      const read = this.runtime.authority.readRequest(call);
      return { ...read, targets: read.scopes.map((item) => {
        const host = this.runtime.hosts.get(item.hostId);
        return { ...item, name: host.config.name, endpoint: `${host.config.host}:${host.config.port}`, username: host.config.username, environment: host.config.environment };
      }), alreadyGranted: this.runtime.authority.hasReadPermission(call) };
    }
    if (command.kind === "read-decision") { this.runtime.authority.recordReadDecision(call, command.decision); return { recorded: true }; }
    if (command.kind === "prepare") {
      const prepared = await this.runtime.authority.prepare(call);
      const endpoints = new Set(prepared.targets.map((target) => `${remoteEndpoint(target.host.config)}|${target.host.config.username}`));
      const unknownWrites = ["exec", "upload", "write_file"].includes(prepared.operation) ? this.runtime.journal.list().filter((record) =>
        ["execution_unknown", "needs_review", "reconciling"].includes(record.state) && ["exec", "upload", "write_file"].includes(record.operation) &&
        endpoints.has(`${record.display.endpoint.toLowerCase()}|${record.display.username}`)).slice(0, 200).map((record) => ({ executionId: record.executionId,
        hostId: record.hostId, display: record.display, operation: record.operation, remotePath: record.remotePath, uploadStage: record.uploadStage, state: record.state })) : [];
      return { ...remoteApprovalPreview(prepared), unknownWrites, sessionAuthorizationOffer: this.runtime.authority.sessions.offer(call) };
    }
    if (command.kind === "final-decision") return this.runtime.authority.recordFinalDecision(call, command.preparedCallId, command.decision);
    if (command.kind === "approve-session-operation") {
      if (command.mode === "plan" || !this.runtime.authority.sessions.coverage(call)) return { granted: false };
      this.runtime.authority.approveSessionOperation(call, command.preparedCallId, command.mode); return { granted: true };
    }
    if (command.kind === "approve-scoped-read") return this.runtime.authority.approveScopedRead(call, command.preparedCallId);
    throw new RemoteHostError("invalid_request", "The private control operation is unsupported.");
  }

  revokeHost(hostId: string): void {
    for (const [id, agent] of this.agents) if (agent.scope.hostId === hostId) {
      this.runtime.authority.sessions.revokeWindow(agent.scope.windowId); this.revoke(id);
    }
    this.plugins.releaseHost(hostId);
  }
  async dispose(): Promise<void> { for (const id of this.agents.keys()) this.revoke(id); await this.endpoint.dispose(); }

  private async open(scope: RemoteHostMainScope, command: Extract<RemoteHostControlCommand, { kind: "open-agent" }>): Promise<unknown> {
    const existing = this.agents.get(command.clientInstanceId);
    if (existing) {
      if (existing.scope.hostId !== scope.hostId || existing.scope.windowId !== scope.windowId || existing.principal.agentGeneration !== command.agentGeneration ||
        existing.principal.workspaceKey !== command.workspaceKey || existing.workspaceRoot !== command.workspaceRoot) {
        throw new RemoteHostError("permission_denied", "The Agent registration identifier is already in use.", "authorization");
      }
      return { ...existing.credential, ...existing.principal };
    }
    if (this.agents.size >= 512) throw new RemoteHostError("storage_busy", "The broker Agent registration budget is full.");
    const principal: RemoteClientPrincipal = { ownerId: this.runtime.database.ownerId, clientInstanceId: command.clientInstanceId,
      workspaceKey: command.workspaceKey, agentGeneration: command.agentGeneration, brokerGeneration: this.runtime.registry.generation };
    await this.endpoint.start();
    const credential = this.endpoint.issue(principal);
    this.runtime.authority.sessions.register(principal, scope.windowId, command.workspaceRoot);
    this.agents.set(command.clientInstanceId, { scope, principal, workspaceRoot: command.workspaceRoot, pluginEnabled: false, loadedPluginEnabled: false, credential });
    return { ...credential, ...principal };
  }
  private revokeInvocations(clientInstanceId: string, reason = "client_exited"): void {
    this.runtime.connections.revokeClient(clientInstanceId);
    if (reason.startsWith("plugin_")) {
      const agent = this.agents.get(clientInstanceId);
      if (agent) this.runtime.authority.sessions.revokeWorkspace(agent.principal.workspaceKey);
    }
    this.runtime.authority.revokeClient(clientInstanceId);
    this.runtime.registry.revokeClient(clientInstanceId); this.runtime.coordinator.revokeClient(clientInstanceId, reason);
  }
  private revoke(clientInstanceId: string): void {
    this.revokeInvocations(clientInstanceId); this.endpoint.revokeClient(clientInstanceId); this.runtime.authority.sessions.unregister(clientInstanceId); this.agents.delete(clientInstanceId);
  }
}
