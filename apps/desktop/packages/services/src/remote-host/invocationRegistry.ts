import { randomUUID } from "node:crypto";
import { RemoteHostError, parseRemoteToolInput, type RemoteCallContext, type RemoteHostToolName } from "@fcode/shared";
import { RemoteSelectionStore } from "./selectionStore.js";
import { remoteInputDigest } from "./canonicalInput.js";

const MAX_REGISTRY_RECORDS = 512;
const SUBMISSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface RemoteClientPrincipal {
  ownerId: string;
  clientInstanceId: string;
  workspaceKey: string;
  agentGeneration: string;
  brokerGeneration: string;
}

interface RegisteredTurn { context: Omit<RemoteCallContext, "toolCallId"> }
export interface RegisteredRemoteCall {
  callId: string;
  context: RemoteCallContext;
  tool: RemoteHostToolName;
  input: Record<string, unknown>;
  inputDigest: string;
  started: boolean;
}

function principalKey(scope: RemoteClientPrincipal): string {
  return JSON.stringify([scope.ownerId, scope.clientInstanceId, scope.workspaceKey, scope.agentGeneration, scope.brokerGeneration]);
}
function turnKey(scope: RemoteClientPrincipal, sessionId: string, turnId: string): string {
  return JSON.stringify([principalKey(scope), sessionId, turnId]);
}

/** Registration methods are reachable only from the private Main/Host control channel. */
export class RemoteInvocationRegistry {
  private readonly submissions = new Map<string, { selectionId: string; expiresAt: number }>();
  private readonly turns = new Map<string, RegisteredTurn>();
  private readonly calls = new Map<string, RegisteredRemoteCall>();
  constructor(private readonly selections: RemoteSelectionStore, readonly generation = randomUUID()) {}

  registerSubmission(scope: RemoteClientPrincipal, submissionId: string, selectionId: string): void {
    this.checkPrincipal(scope); this.expire();
    const selection = this.selections.get(selectionId);
    if (selection.ownerId !== scope.ownerId || selection.workspaceKey !== scope.workspaceKey || selection.submissionId !== submissionId) {
      throw new RemoteHostError("permission_denied", "The submitted remote selection does not match its owner.", "authorization");
    }
    if (this.submissions.size >= MAX_REGISTRY_RECORDS) throw new RemoteHostError("storage_busy", "Too many remote submissions are pending.", "authorization");
    this.submissions.set(JSON.stringify([principalKey(scope), submissionId]), { selectionId, expiresAt: Date.now() + SUBMISSION_TTL_MS });
  }

  startTurn(scope: RemoteClientPrincipal, event: {
    sessionId: string; turnId: string; messageId: string; inputId: string; traceId: string;
    humanUser: boolean; runtimeScope: "main" | "subagent";
  }): void {
    this.checkPrincipal(scope); this.expire();
    const pendingKey = JSON.stringify([principalKey(scope), event.inputId]);
    const pending = this.submissions.get(pendingKey);
    this.submissions.delete(pendingKey);
    if (!event.humanUser || event.runtimeScope !== "main") return;
    const key = turnKey(scope, event.sessionId, event.turnId);
    if (this.turns.has(key) || this.turns.size >= MAX_REGISTRY_RECORDS) {
      throw new RemoteHostError("permission_denied", "The remote turn is duplicated or exceeds its registry budget.", "authorization");
    }
    if (pending) this.selections.bindMessage({ ownerId: scope.ownerId, workspaceKey: scope.workspaceKey, selectionId: pending.selectionId,
      sessionId: event.sessionId, messageId: event.messageId, submissionId: event.inputId });
    this.turns.set(key, { context: { ...scope, sessionId: event.sessionId, turnId: event.turnId,
      messageId: event.messageId, traceId: event.traceId, runtimeScope: "main",
      ...(pending ? { selectionId: pending.selectionId } : {}) } });
  }

  scheduleCall(scope: RemoteClientPrincipal, input: {
    sessionId: string; turnId: string; toolCallId: string; tool: RemoteHostToolName;
    trustedBuiltin: boolean; input: unknown;
  }): void {
    this.checkPrincipal(scope);
    if (!input.trustedBuiltin) throw new RemoteHostError("permission_denied", "Only the bundled remote runtime may register these calls.", "authorization");
    const turn = this.turns.get(turnKey(scope, input.sessionId, input.turnId));
    if (!turn) throw new RemoteHostError("selection_required", "This call has no live human user turn.", "authorization");
    const key = this.callKey(scope, input.sessionId, input.turnId, input.toolCallId);
    if (this.calls.has(key) || this.calls.size >= MAX_REGISTRY_RECORDS) throw new RemoteHostError("permission_denied", "This remote invocation is duplicated or exceeds its budget.", "authorization");
    const parsed = parseRemoteToolInput(input.tool, input.input);
    this.calls.set(key, { callId: randomUUID(), tool: input.tool, input: parsed, inputDigest: remoteInputDigest(parsed),
      started: false, context: { ...turn.context, toolCallId: input.toolCallId } });
  }

  startCall(scope: RemoteClientPrincipal, input: { sessionId: string; turnId: string; toolCallId: string }): void {
    this.resolve(scope, input).started = true;
  }

  rewriteCall(scope: RemoteClientPrincipal, identity: { sessionId: string; turnId: string; toolCallId: string },
    tool: RemoteHostToolName, raw: unknown): RegisteredRemoteCall {
    const previous = this.resolve(scope, identity);
    if (previous.started || previous.tool !== tool) throw new RemoteHostError("approval_mismatch", "A started invocation or tool identity cannot be rewritten.", "authorization");
    const input = parseRemoteToolInput(tool, raw);
    const next = { ...previous, callId: randomUUID(), input, inputDigest: remoteInputDigest(input) };
    this.calls.set(this.callKey(scope, identity.sessionId, identity.turnId, identity.toolCallId), next);
    return next;
  }

  resolve(scope: RemoteClientPrincipal, input: { sessionId: string; turnId: string; toolCallId: string }): RegisteredRemoteCall {
    this.checkPrincipal(scope);
    const call = this.calls.get(this.callKey(scope, input.sessionId, input.turnId, input.toolCallId));
    if (!call || !this.turns.has(turnKey(scope, input.sessionId, input.turnId))) {
      throw new RemoteHostError("permission_denied", "This remote invocation is expired or was revoked.", "authorization");
    }
    return call;
  }

  checkInput(scope: RemoteClientPrincipal, identity: { sessionId: string; turnId: string; toolCallId: string }, tool: RemoteHostToolName, input: unknown): RegisteredRemoteCall {
    const call = this.resolve(scope, identity);
    if (call.tool !== tool || call.inputDigest !== remoteInputDigest(parseRemoteToolInput(tool, input))) {
      throw new RemoteHostError("approval_mismatch", "The remote operation differs from the registered tool input.", "authorization");
    }
    return call;
  }

  hasSelectedTurn(workspaceKey: string, sessionId: string): boolean {
    return [...this.turns.values()].some(({ context }) => context.workspaceKey === workspaceKey && context.sessionId === sessionId && Boolean(context.selectionId));
  }

  closeCall(scope: RemoteClientPrincipal, identity: { sessionId: string; turnId: string; toolCallId: string }): void {
    this.calls.delete(this.callKey(scope, identity.sessionId, identity.turnId, identity.toolCallId));
  }
  closeTurn(scope: RemoteClientPrincipal, sessionId: string, turnId: string): void {
    this.turns.delete(turnKey(scope, sessionId, turnId));
    for (const [key, call] of this.calls) {
      if (principalKey(call.context) === principalKey(scope) && call.context.sessionId === sessionId && call.context.turnId === turnId) this.calls.delete(key);
    }
  }
  closeSession(scope: RemoteClientPrincipal, sessionId: string): void {
    for (const turn of this.turns.values()) if (principalKey(turn.context) === principalKey(scope) && turn.context.sessionId === sessionId) {
      this.closeTurn(scope, sessionId, turn.context.turnId);
    }
  }
  revokeClient(clientInstanceId: string): void {
    for (const [key, turn] of this.turns) if (turn.context.clientInstanceId === clientInstanceId) this.turns.delete(key);
    for (const [key, call] of this.calls) if (call.context.clientInstanceId === clientInstanceId) this.calls.delete(key);
    for (const [key] of this.submissions) if (JSON.parse(JSON.parse(key)[0])[1] === clientInstanceId) this.submissions.delete(key);
  }
  dispose(): void { this.submissions.clear(); this.calls.clear(); this.turns.clear(); }

  private callKey(scope: RemoteClientPrincipal, sessionId: string, turnId: string, toolCallId: string): string {
    return JSON.stringify([principalKey(scope), sessionId, turnId, toolCallId]);
  }
  private checkPrincipal(scope: RemoteClientPrincipal): void {
    if (scope.brokerGeneration !== this.generation) throw new RemoteHostError("permission_denied", "The broker generation has expired.", "authorization");
  }
  private expire(): void {
    for (const [key, value] of this.submissions) if (value.expiresAt <= Date.now()) this.submissions.delete(key);
  }
}
