import { remoteHostHardDenyReason } from "./remote-host-hard-deny.js";
import { CoreErrorType, createCoreError, type CollaborationMode, type TraceContext, type PermissionBrokerRequest } from "@fcode/contracts";
import { remoteHostToolSchemas, type RemoteHostScopedControl } from "@fcode/shared";
import type { ExecutableToolCall, ToolEntry, ToolExecutionResult } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { emitPermissionRequested, emitPermissionResolved } from "./events.js";
import { createErrorResult, createPermissionErrorResult } from "./errors.js";
import { runPermissionRequestHooks } from "./hook-flow.js";
import { normalizeToolExecutionInput } from "../input-normalization.js";

export async function resolveRemoteHostPermission(deps: ToolExecutorDeps, toolCall: ExecutableToolCall, entry: ToolEntry,
  input: unknown, mode: CollaborationMode, trace: TraceContext, signal?: AbortSignal): Promise<
    { allowed: true; executionInput: unknown; permissionWaitMs: number } | { allowed: false; result: ToolExecutionResult }> {
  const remote = entry.remoteHostOperation!;
  const started = Date.now();
  const turnId = trace.turnId ?? deps.turnId;
  if (!turnId || deps.runtimeScope === "subagent" || deps.workspaceIdentity || deps.remoteSessionId || deps.clientMode === "web-remote-replayable") {
    return { allowed: false, result: createPermissionErrorResult(toolCall, "Remote Host requires the main local desktop user turn.", { mode, decision: "deny" }) };
  }
  const identity = { sessionId: String(deps.sessionId), turnId: String(turnId), toolCallId: toolCall.id };
  const control = (command: RemoteHostScopedControl) => remote.port.control(command);
  let registered = false;
  try {
    signal?.throwIfAborted();
    let executionInput = remoteHostToolSchemas[remote.method].parse(input);
    const hardDeny = await remoteHostHardDenyReason(deps, entry, toolCall.name, executionInput, mode);
    if (hardDeny) throw new Error(hardDeny);
    await control({ kind: "register-call", identity, tool: remote.method, input: executionInput, trustedBuiltin: true }); registered = true;
    const isOperation = ["exec", "upload", "write_file", "read_file", "list_directory"].includes(remote.method);
    const isWrite = ["exec", "upload", "write_file"].includes(remote.method);
    if (mode === "plan" && isWrite) throw new Error("Remote writes are unavailable in plan mode.");
    const assertLiveMode = () => { if (isWrite && deps.getMode?.() === "plan") throw new Error("Remote writes cannot start after switching to plan mode."); };
    const requestDecision = async (phase: "preflight" | "operation", details: Record<string, unknown>, canRemember = false) => {
      const unknownIds = phase === "operation" && Array.isArray(details.unknownWrites) ? details.unknownWrites.flatMap((item) =>
        typeof item === "object" && item !== null && "executionId" in item && typeof item.executionId === "string" ? [item.executionId] : []) : [];
      const canAuthorizeSession = mode !== "plan" && deps.getMode?.() !== "plan" && Boolean(details.sessionAuthorizationOffer);
      const optionsPolicy = unknownIds.length ? "remote-write-risk" as const : canAuthorizeSession ? "remote-session-authorization" as const : canRemember ? "remote-read-scope" as const : "no-always-allow" as const;
      assertLiveMode();
      signal?.throwIfAborted();
      const requestId = `remote_permission_${crypto.randomUUID()}`;
      const reason = phase === "preflight" ? "Approve the bounded remote preflight and any listed local source read." : "Approve this exact remote operation on the listed hosts.";
      await emitPermissionRequested(deps, toolCall, executionInput, requestId, isWrite ? "high" : "low", reason, [], trace,
        { optionsPolicy, display: { kind: "remote_host_approval", phase, details } });
      // Only the real client permission broker may answer. Hook, project rules, yolo and Full access cannot authorize this call.
      const result = await deps.permissionBroker.requestPermission({ requestId, sessionId: deps.sessionId, turnId,
        traceId: trace.traceId, toolCallId: toolCall.id as PermissionBrokerRequest["toolCallId"], toolName: toolCall.name,
        input: executionInput, mode, ruleId: "remote-host.exact-user-confirmation", reason, riskLevel: isWrite ? "high" : "low",
        sideEffectScope: "network", suggestedPermissionUpdates: [], optionsPolicy, requestedAt: new Date() },
        { signal, timeoutMs: deps.permissionTimeoutMs });
      assertLiveMode();
      if (result.remoteHostSessionAuthorization && (!canAuthorizeSession || deps.getMode?.() === "plan")) throw new Error("Session authorization is unavailable for this permission request or mode.");
      await emitPermissionResolved(deps, toolCall, requestId, { ...result, resolvedAt: result.resolvedAt ?? new Date() }, trace);
      if (result.decision !== "allow" || result.permissionUpdates?.length || result.sessionPermissionUpdates?.length) throw new Error("This remote operation was not approved once by the user.");
      return { source: "user_prompt" as const, responseId: requestId, sessionOfferId: result.remoteHostSessionAuthorization && canAuthorizeSession ? (details.sessionAuthorizationOffer as { sessionOfferId: string }).sessionOfferId : undefined, decision: result.remoteHostSessionAuthorization && canAuthorizeSession ? "allow_session" as const : result.remoteHostReadScope && canRemember ? "allow_read_scope" as const : "allow_once" as const, acknowledgedUnknownExecutionIds: result.remoteHostRiskAccepted ? unknownIds : [], mode: mode === "plan" ? "plan" as const : "default" as const };
    };
    if (isOperation) {
      // Hooks may deny or modify, but an allow is never an approval. Modified input is registered and prepared afresh.
      const hook = await runPermissionRequestHooks(deps, toolCall, executionInput, `remote_hook_${crypto.randomUUID()}`,
        { allowed: false, decision: "ask", escalated: false, mode, ruleId: "remote-host.exact-user-confirmation", riskLevel: isWrite ? "high" : "low", alwaysAsk: true }, mode, trace, signal, entry);
      if (hook?.decision === "deny" || hook?.decision === "escalate") throw new Error(hook.reason ?? "Denied by the remote permission hook.");
      if (hook?.decision === "modify") {
        executionInput = remoteHostToolSchemas[remote.method].parse(normalizeToolExecutionInput({ entry, input: hook.modifiedInput ?? executionInput, source: "permission", logger: deps.logger }));
        const modifiedDeny = await remoteHostHardDenyReason(deps, entry, toolCall.name, executionInput, mode);
        if (modifiedDeny) throw new Error(modifiedDeny);
        await control({ kind: "rewrite-call", identity, tool: remote.method, input: executionInput, trustedBuiltin: true });
      }
      const read = await control({ kind: "read-request", identity }) as Record<string, unknown>;
      if (!read.alreadyGranted) await control({ kind: "read-decision", identity, decision: await requestDecision("preflight", read, !isWrite && read.canRemember === true) });
      const prepared = await control({ kind: "prepare", identity }) as Record<string, unknown>;
      const preparedCallId = String(prepared.preparedCallId);
      // A scoped read grant is checked again by the broker; it can never cover a write or command.
      let granted = false;
      if (mode !== "plan" && deps.getMode?.() !== "plan") {
        const approval = await control({ kind: "approve-session-operation", identity, preparedCallId, mode: "default" }) as { granted?: boolean };
        granted = approval?.granted === true;
      }
      if (!granted && !isWrite) {
        try { await control({ kind: "approve-scoped-read", identity, preparedCallId }); granted = true; } catch { /* Explicit confirmation follows. */ }
      }
      if (!granted) await control({ kind: "final-decision", identity, preparedCallId, decision: await requestDecision("operation", prepared, !isWrite && read.canRemember === true) });
    }
    assertLiveMode(); signal?.throwIfAborted(); await control({ kind: "start-call", identity });
    return { allowed: true, executionInput, permissionWaitMs: Date.now() - started };
  } catch (error) {
    if (registered) await control({ kind: "close-call", identity }).catch(() => {});
    return { allowed: false, result: createErrorResult(toolCall, createCoreError(CoreErrorType.PermissionDenied,
      error instanceof Error ? error.message : "Remote Host authorization failed.", { recoverable: true })) };
  }
}
