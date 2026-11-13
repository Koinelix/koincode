import { RemoteHostError, type RemoteCallContext, type RemoteHostRecord, type RemoteOperation } from "@fcode/shared";
import type { RemoteExecutionJournal } from "./executionJournal.js";
import { remoteEndpoint } from "./hostCatalog.js";

export interface RemoteRetryReference { executionId: string; attempt: number }
const RETRYABLE = new Set(["failed", "canceled", "needs_review"]);

export function resolveRemoteRetry(journal: RemoteExecutionJournal, context: RemoteCallContext, operation: RemoteOperation,
  host: RemoteHostRecord, retryOf: RemoteRetryReference | undefined, requestId: string): RemoteRetryReference | undefined {
  if (!retryOf) return undefined;
  const previous = journal.get(retryOf.executionId);
  if (previous.context.ownerId !== context.ownerId || previous.context.workspaceKey !== context.workspaceKey ||
    previous.context.sessionId !== context.sessionId || previous.hostId !== host.hostId || previous.operation !== operation || previous.attempt !== retryOf.attempt) {
    throw new RemoteHostError("permission_denied", "The retry reference does not belong to this conversation, target, operation and attempt.", "authorization");
  }
  if (previous.display.endpoint !== remoteEndpoint(host.config) || previous.display.username !== host.config.username) {
    throw new RemoteHostError("target_changed", "The original retry endpoint or account changed. Establish a new independent operation.");
  }
  if (!RETRYABLE.has(previous.state)) throw new RemoteHostError("invalid_request", "Only failed, canceled or reconciled needs-review records can be retried. Reconcile an unknown result first.");
  if (previous.requestId === requestId) throw new RemoteHostError("idempotency_conflict", "A retry requires a new request identifier.", "authorization");
  return { executionId: previous.executionId, attempt: previous.attempt };
}
