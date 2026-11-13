import { setTimeout as delay } from "node:timers/promises";
import { REMOTE_HOST_LIMITS, RemoteHostError, remoteHostToolSchemas, remoteExecutionOutputArtifactId, type RemoteHostToolName } from "@fcode/shared";
import type { RemoteHostRuntime } from "./runtime.js";
import { publicRemoteSource } from "./sourceSummary.js";
import type { RemoteClientPrincipal } from "./invocationRegistry.js";
import type { RemoteClientInvocation } from "./clientEndpoint.js";

function encodedCursor(id: string, offset: number): string { return Buffer.from(JSON.stringify([id, offset])).toString("base64url"); }
function offsetFor(cursor: string | null | undefined, id: string): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (Array.isArray(value) && value.length === 2 && value[0] === id && Number.isSafeInteger(value[1]) && value[1] >= 0) return value[1];
  } catch { /* Stable cursor failure follows. */ }
  throw new RemoteHostError("invalid_request", "The remote context cursor is invalid. Retry with null cursors for the first page, or copy the exact cursor from the previous response.", "configuration", false, false);
}

export async function invokeRemoteHostClient(runtime: RemoteHostRuntime, principal: RemoteClientPrincipal,
  identity: RemoteClientInvocation["identity"], method: RemoteHostToolName, input: unknown, signal: AbortSignal): Promise<unknown> {
  const call = runtime.registry.checkInput(principal, identity, method, input);
  if (!call.started) throw new RemoteHostError("permission_denied", "The actual tool invocation has not started.", "authorization");
  if (method === "get_remote_context") {
    const args = remoteHostToolSchemas.get_remote_context.parse(input);
    if (!call.context.selectionId) return { selectionRequired: true, hosts: [], sources: [], hostTotal: 0, sourceTotal: 0 };
    const selection = runtime.selections.forCall(call.context);
    const hostOffset = offsetFor(args.hostCursor, selection.selectionId);
    const sourceOffset = offsetFor(args.sourceCursor, selection.selectionId);
    const candidates = selection.targets.slice(hostOffset, hostOffset + args.limit).map((target) => {
      const host = runtime.catalog.summary(runtime.hosts.get(target.hostId));
      return { hostId: host.hostId, name: host.config.name, host: host.config.host, port: host.config.port,
        username: host.config.username, environment: host.config.environment, securityRevision: host.securityRevision,
        trustRevision: host.trustRevision, trustState: host.trustState, credentialState: host.credentialState,
        defaultCwd: host.config.defaultCwd, fileRoots: host.config.fileRoots.slice(0, 2), fileRootTotal: host.config.fileRoots.length, fileRootsTruncated: host.config.fileRoots.length > 2 };
    });
    const hosts = budgetPage(candidates, 21 * 1024);
    const sources = budgetPage(selection.sourceIds.slice(sourceOffset, sourceOffset + args.limit).map((id) => publicRemoteSource(runtime.sources.get(id))), 9 * 1024);
    return { selectionId: selection.selectionId, selectionRequired: false, hosts, sources,
      hostTotal: selection.targets.length, sourceTotal: selection.sourceIds.length,
      ...(hostOffset + hosts.length < selection.targets.length ? { hostCursor: encodedCursor(selection.selectionId, hostOffset + hosts.length) } : {}),
      ...(sourceOffset + sources.length < selection.sourceIds.length ? { sourceCursor: encodedCursor(selection.selectionId, sourceOffset + sources.length) } : {}) };
  }
  if (method === "get_execution") {
    const args = remoteHostToolSchemas.get_execution.parse(input);
    if (args.waitMs) await delay(args.waitMs, undefined, { signal });
    runtime.registry.checkInput(principal, identity, method, input);
    const details = await runtime.executionDetails.access(runtime.coordinator.getOwned(call.context, args.executionIds));
    runtime.registry.checkInput(principal, identity, method, input);
    const records = details.records;
    const executions = records.map(({ executionId, hostId, attempt, retryOf, operation, state, createdAt, startedAt, deadlineAt,
      updatedAt, exitCode, signal, verification, error, result, remotePath, manifestHash, sourceId, uploadedBytes, uploadedFiles, outputBytes, outputTruncated,
      outputArtifactId, outputExpiredAt, outputPurgedAt, eventsPurgedAt, uploadStage, stagingPath, backupPath, receiptPath, residualPaths }) =>
      ({ executionId, hostId, attempt, retryOf, operation, state, createdAt, startedAt, deadlineAt, updatedAt, exitCode, signal, verification, error, remotePath, manifestHash, sourceId, uploadedBytes, uploadedFiles,
        result, outputBytes, outputTruncated, outputArtifactId: outputArtifactId ?? (operation === "exec" && outputBytes > 0 ? remoteExecutionOutputArtifactId(executionId, attempt) : undefined),
        outputExpiredAt, outputPurgedAt, eventsPurgedAt, uploadStage, stagingPath, backupPath, receiptPath, residualPaths }));
    const candidates = records.filter((record) => record.outputExpiredAt === undefined).flatMap((execution) => runtime.journal.events(execution.executionId, args.afterSequence, 20)).sort((a, b) => a.sequence - b.sequence);
    assertRemoteModelBudget({ executions, events: [] });
    const events = budgetPage(candidates, Math.max(0, REMOTE_HOST_LIMITS.modelBytes - Buffer.byteLength(JSON.stringify({ executions, events: [] })) - 256));
    return { executions, events, maintenancePending: details.maintenancePending, eventsTruncated: events.length < candidates.length, nextSequence: events.at(-1)?.sequence ?? args.afterSequence };
  }
  if (method === "cancel_execution") {
    const args = remoteHostToolSchemas.cancel_execution.parse(input);
    const details = await runtime.executionDetails.access(runtime.coordinator.cancelOwned(call.context, args.executionIds, "model_requested_cancellation"));
    runtime.registry.checkInput(principal, identity, method, input);
    return { executions: details.records, maintenancePending: details.maintenancePending };
  }
  signal.throwIfAborted();
  const preparedCallId = runtime.authority.approvedForCall(call);
  const executions = runtime.coordinator.dispatch(call, preparedCallId);
  return { executions: executions.map(({ executionId, hostId, state }) => ({ executionId, hostId, state })),
    accepted: true, continuing: executions.some((record) => ["queued", "dispatching", "running", "verifying", "cancel_requested"].includes(record.state)),
    message: "Poll get_execution for the verified outcome." };
}

export function assertRemoteModelBudget(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > REMOTE_HOST_LIMITS.modelBytes) throw new RemoteHostError("output_limit", "Use a smaller remote context or execution page.");
}

function budgetPage<T>(items: T[], budget: number): T[] {
  const page: T[] = []; let bytes = 2;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > budget) break;
    page.push(item); bytes += size;
  }
  return page;
}
