import { RemoteSessionAuthorizations } from "./sessionAuthorizations.js";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import { REMOTE_HOST_LIMITS, RemoteHostError, remoteHumanPermissionDecisionSchema } from "@fcode/shared";
import { RemoteInvocationRegistry, type RegisteredRemoteCall } from "./invocationRegistry.js";
import { RemoteSelectionStore } from "./selectionStore.js";
import { RemoteHostRepository } from "./hostRepository.js";
import { RemoteCallPreparer } from "./preparer.js";
import { remoteInputDigest } from "./canonicalInput.js";
import { isSensitiveUploadPath } from "./snapshotManifest.js";
import type { RemotePreparedCall, RemoteApprovalBinding, RemoteReadScope } from "./preparedTypes.js";

const MAX_PENDING_CALLS = 512;
const humanDecisionSchema = remoteHumanPermissionDecisionSchema;
export type RemoteHumanDecision = z.input<typeof humanDecisionSchema>;
export interface RemoteReadRequest {
  callId: string;
  scopes: RemoteReadScope[];
  localPath?: string;
  canRemember: boolean;
  sessionAuthorizationOffer?: import("@fcode/shared").RemoteSessionAuthorizationOffer;
}
interface ReadDecision { digest: string; expiresAt: number; localRead: boolean; mode: "default" | "plan"; context: import("@fcode/shared").RemoteCallContext }
interface ReadGrant { sessionId: string; selectionId: string; clientInstanceId: string; digest: string; expiresAt: number }

function writeOperation(tool: string): boolean { return tool === "exec" || tool === "write_file" || tool === "upload"; }

/** Mutating methods are private control-channel handlers, never part of the MCP endpoint. */
export class RemoteApprovalAuthority {
  readonly sessions: RemoteSessionAuthorizations;
  private readonly preparing = new Map<string, { controller: AbortController; context: import("@fcode/shared").RemoteCallContext; ids: string[] }>();
  private readonly reads = new Map<string, ReadDecision>();
  private readonly grants: ReadGrant[] = [];
  private readonly prepared = new Map<string, RemotePreparedCall>();
  private readonly approvals = new Map<string, RemoteApprovalBinding>();
  constructor(private readonly registry: RemoteInvocationRegistry, private readonly selections: RemoteSelectionStore,
    private readonly hosts: RemoteHostRepository, private readonly preparer: RemoteCallPreparer,
    private readonly assertPluginAvailable: (context: import("@fcode/shared").RemoteCallContext) => void) { this.sessions = new RemoteSessionAuthorizations(hosts, selections); }

  readRequest(call: RegisteredRemoteCall): RemoteReadRequest {
    this.checkLive(call);
    const selection = this.selections.forCall(call.context);
    const targets = "targets" in call.input ? call.input.targets as Array<Record<string, unknown>> : [call.input];
    const hostIds = targets.map((target) => String(target.hostId));
    if (new Set(hostIds).size !== hostIds.length) throw new RemoteHostError("invalid_request", "Duplicate remote targets are not allowed.");
    const scopes: RemoteReadScope[] = targets.flatMap((target) => {
      const selected = selection.targets.find((item) => item.hostId === target.hostId);
      if (!selected) throw new RemoteHostError("permission_denied", "The call includes a host outside the fixed selection.", "authorization");
      const host = this.hosts.get(selected.hostId);
      const path = String(target.path ?? target.remotePath ?? target.cwd ?? host.config.defaultCwd ?? ".");
      const primary: RemoteReadScope = { hostId: selected.hostId, securityRevision: selected.securityRevision, trustRevision: selected.trustRevision,
        path: posix.normalize(path), category: call.tool === "read_file" || call.tool === "list_directory" ? call.tool : "preflight" };
      const verify = target.verify as { cwd?: string } | undefined;
      if (call.tool !== "exec" || !verify) return [primary];
      const verifyPath = posix.normalize(verify.cwd ?? host.config.defaultCwd ?? ".");
      return verifyPath === primary.path ? [primary] : [primary, { ...primary, path: verifyPath }];
    });
    const source = call.input.source as { kind?: string; path?: string } | undefined;
    const localPath = source?.kind === "workspace_path" && source.path ? this.preparer.workspaceSourcePath(call.context, source.path) : undefined;
    const canRemember = !localPath && scopes.every((scope) => this.hosts.get(scope.hostId).config.environment !== "production" && !isSensitiveUploadPath(scope.path));
    return { callId: call.callId, scopes, ...(localPath ? { localPath } : {}), canRemember, sessionAuthorizationOffer: this.sessions.offer(call) };
  }

  recordReadDecision(call: RegisteredRemoteCall, raw: RemoteHumanDecision): void {
    const decision = humanDecisionSchema.parse(raw);
    const request = this.readRequest(call);
    if (decision.decision === "deny") { this.invalidateCall(call.callId); throw new RemoteHostError("permission_denied", "The remote preflight read was denied.", "authorization"); }
    if (decision.mode === "plan" && writeOperation(call.tool)) throw new RemoteHostError("permission_denied", "Remote writes cannot run in plan mode.", "authorization");
    if (decision.decision === "allow_session") {
      if (decision.mode === "plan") throw new RemoteHostError("permission_denied", "Session authorization cannot be granted in plan mode.", "authorization");
      this.sessions.grant(call, decision.sessionOfferId, decision.responseId);
    }
    if (decision.decision === "allow_read_scope" && !request.canRemember) throw new RemoteHostError("permission_denied", "Production, sensitive, and local source reads require individual confirmation.", "authorization");
    if (this.reads.size >= MAX_PENDING_CALLS && !this.reads.has(call.callId)) throw new RemoteHostError("storage_busy", "Too many permission preparations are pending.");
    const digest = remoteInputDigest(request);
    this.reads.set(call.callId, { digest, localRead: Boolean(request.localPath), mode: decision.mode, context: { ...call.context },
      expiresAt: Date.now() + REMOTE_HOST_LIMITS.dispatchMs });
    if (decision.decision === "allow_read_scope") {
      this.addGrant(call, request);
    }
  }

  hasReadPermission(call: RegisteredRemoteCall): boolean {
    const request = this.readRequest(call);
    const decision = this.reads.get(call.callId);
    return Boolean(decision && decision.expiresAt > Date.now() && decision.digest === remoteInputDigest(request)) ||
      request.canRemember && this.matchGrant(call, request) || Boolean(this.sessions.coverage(call));
  }

  async prepare(call: RegisteredRemoteCall, signal?: AbortSignal): Promise<RemotePreparedCall> {
    if (this.prepared.size >= MAX_PENDING_CALLS) throw new RemoteHostError("storage_busy", "Too many prepared remote calls are pending.");
    const assertRead = () => {
      this.checkLive(call);
      if (!this.hasReadPermission(call)) throw new RemoteHostError("approval_required", "Approve the bounded preflight reads before preparing this call.", "authorization");
    };
    assertRead();
    const selection = this.selections.forCall(call.context);
    const deadline = AbortSignal.timeout(REMOTE_HOST_LIMITS.commandMs);
    if (this.preparing.has(call.callId)) throw new RemoteHostError("storage_busy", "This call is already preparing.");
    const preparation = { controller: new AbortController(), context: call.context, ids: this.sessions.coverage(call)?.ids ?? [] };
    this.preparing.set(call.callId, preparation);
    let prepared: RemotePreparedCall;
    try {
      prepared = await this.preparer.prepare(call, selection, assertRead, this.reads.get(call.callId)?.localRead === true || Boolean(this.sessions.coverage(call)),
        AbortSignal.any([preparation.controller.signal, deadline, ...(signal ? [signal] : [])]));
    } finally { this.preparing.delete(call.callId); }
    try { assertRead(); }
    catch (error) { prepared.releaseSource?.(); throw error; }
    for (const [id, previous] of this.prepared) if (previous.call.callId === call.callId) this.dropPrepared(id);
    this.prepared.set(prepared.preparedCallId, prepared);
    return prepared;
  }

  recordFinalDecision(call: RegisteredRemoteCall, preparedCallId: string, raw: RemoteHumanDecision): RemoteApprovalBinding {
    const decision = humanDecisionSchema.parse(raw);
    const prepared = this.getPrepared(call, preparedCallId);
    if (decision.decision === "deny") { this.dropPrepared(preparedCallId); throw new RemoteHostError("permission_denied", "The remote operation was denied.", "authorization"); }
    if (decision.mode === "plan" && writeOperation(prepared.operation)) throw new RemoteHostError("permission_denied", "Remote writes cannot run in plan mode.", "authorization");
    if (decision.decision === "allow_read_scope") {
      const request = this.readRequest(call);
      if (writeOperation(prepared.operation) || !request.canRemember) throw new RemoteHostError("permission_denied", "Only bounded non-production structured reads can receive a temporary grant.", "authorization");
      this.addGrant(call, request);
    }
    if (decision.decision === "allow_session") {
      if (decision.mode === "plan") throw new RemoteHostError("permission_denied", "Session authorization cannot be granted in plan mode.", "authorization");
      this.sessions.grant(call, decision.sessionOfferId, decision.responseId);
      return this.approveSessionOperation(call, preparedCallId, decision.mode);
    }
    return this.bind(prepared, "human", decision.responseId, decision.acknowledgedUnknownExecutionIds);
  }

  approveSessionOperation(call: RegisteredRemoteCall, preparedCallId: string, mode: "default" | "plan"): RemoteApprovalBinding {
    const prepared = this.getPrepared(call, preparedCallId);
    const coverage = this.sessions.coverage(call);
    if (mode === "plan" || !coverage) throw new RemoteHostError("approval_required", "This operation has no current session authorization.", "authorization");
    const approval = this.bind(prepared, "session_grant", "session-authorization", []);
    approval.sessionAuthorizationIds = coverage.ids; return approval;
  }
  cancelAuthorizationPreparations(ids: string[]): void {
    for (const pending of this.preparing.values()) if (pending.ids.some(id => ids.includes(id))) pending.controller.abort(new RemoteHostError("canceled", "Session authorization was revoked during preflight.", "authorization"));
  }
  assertSessionAuthorization(approval: RemoteApprovalBinding): void {
    if (approval.decisionSource === "session_grant") this.sessions.assertCurrent(approval.sessionAuthorizationIds ?? []);
  }
  approveScopedRead(call: RegisteredRemoteCall, preparedCallId: string): RemoteApprovalBinding {
    const prepared = this.getPrepared(call, preparedCallId);
    const request = this.readRequest(call);
    if (writeOperation(prepared.operation) || !request.canRemember || !this.matchGrant(call, request)) {
      throw new RemoteHostError("approval_required", "This operation needs an explicit user decision.", "authorization");
    }
    return this.bind(prepared, "scoped_read_grant", "scoped-read-grant", []);
  }

  authorized(call: RegisteredRemoteCall, preparedCallId: string): { prepared: RemotePreparedCall; approval: RemoteApprovalBinding } {
    const prepared = this.getPrepared(call, preparedCallId);
    if (!call.started) throw new RemoteHostError("permission_denied", "The actual tool invocation has not started.", "authorization");
    const approval = this.approvals.get(preparedCallId);
    if (!approval) throw new RemoteHostError("approval_required", "This exact remote operation has not been approved.", "authorization");
    if (approval.dispatchExpiresAt <= Date.now()) throw new RemoteHostError("approval_expired", "The remote operation approval expired.", "authorization");
    this.assertSessionAuthorization(approval);
    return { prepared, approval };
  }

  consumed(preparedCallId: string): void { this.dropPrepared(preparedCallId); }
  approvedForCall(call: RegisteredRemoteCall): string {
    this.checkLive(call);
    const prepared = [...this.prepared.values()].find((item) => item.call.callId === call.callId && this.approvals.has(item.preparedCallId));
    if (!prepared) throw new RemoteHostError("approval_required", "This exact remote call has no final approval.", "authorization");
    return prepared.preparedCallId;
  }
  invalidateCall(callId: string): void {
    this.preparing.get(callId)?.controller.abort(new RemoteHostError("canceled", "The remote call was closed.", "authorization"));
    this.sessions.forgetCall(callId);
    this.reads.delete(callId);
    for (const [id, prepared] of this.prepared) if (prepared.call.callId === callId) this.dropPrepared(id);
  }
  revokeHost(hostId: string): void {
    this.sessions.revokeHost(hostId);
    this.grants.length = 0;
    for (const [id, prepared] of this.prepared) if (prepared.targets.some((target) => target.host.hostId === hostId)) this.dropPrepared(id);
  }
  revokeClient(clientInstanceId: string): void {
    for (const pending of this.preparing.values()) if (pending.context.clientInstanceId === clientInstanceId) pending.controller.abort(new RemoteHostError("canceled", "The Agent was revoked.", "authorization"));
    for (const [id, prepared] of this.prepared) if (prepared.call.context.clientInstanceId === clientInstanceId) this.dropPrepared(id);
    for (const [id, read] of this.reads) if (read.context.clientInstanceId === clientInstanceId) this.reads.delete(id);
    for (let index = this.grants.length - 1; index >= 0; index--) if (this.grants[index]!.clientInstanceId === clientInstanceId) this.grants.splice(index, 1);
  }
  revokeSession(clientInstanceId: string, sessionId: string): void {
    const scope = this.sessions.clientScope(clientInstanceId);
    if (scope) this.sessions.revokeSession(scope.windowId, scope.workspaceKey, sessionId);
    const matches = (context: import("@fcode/shared").RemoteCallContext) => context.clientInstanceId === clientInstanceId && context.sessionId === sessionId;
    for (const [id, prepared] of this.prepared) if (matches(prepared.call.context)) this.dropPrepared(id);
    for (const [id, read] of this.reads) if (matches(read.context)) this.reads.delete(id);
    for (let index = this.grants.length - 1; index >= 0; index--) {
      const grant = this.grants[index]!;
      if (grant.clientInstanceId === clientInstanceId && grant.sessionId === sessionId) this.grants.splice(index, 1);
    }
  }
  revokeTurn(clientInstanceId: string, sessionId: string, turnId: string): void {
    this.sessions.forgetTurn(clientInstanceId, sessionId, turnId);
    for (const pending of this.preparing.values()) if (pending.context.clientInstanceId === clientInstanceId && pending.context.sessionId === sessionId && pending.context.turnId === turnId) pending.controller.abort(new RemoteHostError("canceled", "The turn was closed.", "authorization"));
    const matches = (context: import("@fcode/shared").RemoteCallContext) => context.clientInstanceId === clientInstanceId && context.sessionId === sessionId && context.turnId === turnId;
    for (const [id, prepared] of this.prepared) if (matches(prepared.call.context)) this.dropPrepared(id);
    for (const [id, read] of this.reads) if (matches(read.context)) this.reads.delete(id);
  }
  dispose(): void { this.sessions.dispose(); for (const pending of this.preparing.values()) pending.controller.abort(); for (const id of this.prepared.keys()) this.dropPrepared(id); this.reads.clear(); this.grants.length = 0; }

  private getPrepared(call: RegisteredRemoteCall, id: string): RemotePreparedCall {
    this.checkLive(call); this.selections.forCall(call.context);
    const prepared = this.prepared.get(id);
    if (!prepared || prepared.call.callId !== call.callId || prepared.operationDigest !== call.inputDigest) {
      throw new RemoteHostError("approval_mismatch", "The prepared input is stale or belongs to another call.", "authorization");
    }
    return prepared;
  }
  private checkLive(call: RegisteredRemoteCall): void {
    this.assertPluginAvailable(call.context);
    const live = this.registry.checkInput(call.context, call.context, call.tool, call.input);
    if (live.callId !== call.callId || call.context.runtimeScope !== "main") throw new RemoteHostError("permission_denied", "The invocation handle is stale.", "authorization");
  }
  private bind(prepared: RemotePreparedCall, source: RemoteApprovalBinding["decisionSource"], responseId: string, unknownIds: string[]): RemoteApprovalBinding {
    const approval: RemoteApprovalBinding = { approvalId: randomUUID(), toolCallId: prepared.call.context.toolCallId,
      preparedCallId: prepared.preparedCallId, brokerGeneration: this.registry.generation,
      operationDigest: prepared.operationDigest, preflightDigest: prepared.preflightDigest, decisionSource: source,
      permissionResponseId: responseId, approvedAt: Date.now(), dispatchExpiresAt: Date.now() + REMOTE_HOST_LIMITS.dispatchMs,
      acceptedUnknownExecutionIds: [...unknownIds] };
    this.approvals.set(prepared.preparedCallId, approval);
    return approval;
  }
  private dropPrepared(id: string): void {
    this.prepared.get(id)?.releaseSource?.(); this.prepared.delete(id); this.approvals.delete(id);
  }
  private grantDigest(call: RegisteredRemoteCall, request: RemoteReadRequest): string {
    return remoteInputDigest({ selectionId: call.context.selectionId, scopes: request.scopes });
  }
  private matchGrant(call: RegisteredRemoteCall, request: RemoteReadRequest): boolean {
    return this.grants.some((grant) => grant.expiresAt > Date.now() && grant.clientInstanceId === call.context.clientInstanceId &&
      grant.selectionId === call.context.selectionId && grant.digest === this.grantDigest(call, request));
  }
  private addGrant(call: RegisteredRemoteCall, request: RemoteReadRequest): void {
    for (let index = this.grants.length - 1; index >= 0; index--) if (this.grants[index]!.expiresAt <= Date.now()) this.grants.splice(index, 1);
    if (this.grants.length >= MAX_PENDING_CALLS) throw new RemoteHostError("storage_busy", "Too many temporary read permissions are active.");
    this.grants.push({ sessionId: call.context.sessionId, selectionId: call.context.selectionId!, clientInstanceId: call.context.clientInstanceId,
      digest: this.grantDigest(call, request), expiresAt: Date.now() + REMOTE_HOST_LIMITS.sourceTtlMs });
  }
}
