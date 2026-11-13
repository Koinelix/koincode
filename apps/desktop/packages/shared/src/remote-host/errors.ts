export const REMOTE_HOST_ERROR_CODES = [
  "invalid_request", "plugin_unavailable", "runtime_protocol_mismatch", "remote_runtime_not_supported",
  "selection_required", "target_changed", "host_disabled", "host_deleted", "revision_conflict",
  "host_key_unknown", "host_key_changed", "challenge_expired", "credential_missing",
  "credential_locked", "credential_corrupt", "secure_store_unavailable", "authentication_failed",
  "interactive_auth_required", "connection_failed", "connection_timeout", "capability_unavailable",
  "permission_denied", "approval_required", "approval_expired", "approval_mismatch",
  "preflight_changed", "idempotency_conflict", "path_not_allowed", "file_conflict",
  "output_limit", "transfer_limit", "source_not_found", "source_changed", "source_sensitive",
  "source_empty", "snapshot_limit", "destination_exists", "insufficient_space",
  "execution_failed", "verification_failed", "hash_unverified", "execution_unknown",
  "cancellation_pending", "storage_busy", "storage_corrupt", "storage_full", "schema_incompatible",
  "canceled", "execution_not_found",
] as const;

export type RemoteHostErrorCode = (typeof REMOTE_HOST_ERROR_CODES)[number];
export type RemoteHostErrorStage =
  | "configuration" | "trust" | "authentication" | "authorization"
  | "connection" | "execution" | "verification" | "storage";

export interface RemoteHostFailure {
  code: RemoteHostErrorCode;
  stage: RemoteHostErrorStage;
  message: string;
  retryable: boolean;
  requiresUserAction: boolean;
}

export class RemoteHostError extends Error {
  readonly name = "RemoteHostError";
  constructor(
    readonly code: RemoteHostErrorCode,
    message: string,
    readonly stage: RemoteHostErrorStage = "configuration",
    readonly retryable = false,
    readonly requiresUserAction = true,
  ) {
    super(message);
  }

  toJSON(): RemoteHostFailure {
    return { code: this.code, stage: this.stage, message: this.message,
      retryable: this.retryable, requiresUserAction: this.requiresUserAction };
  }
}

export function remoteHostFailure(error: unknown): RemoteHostFailure {
  if (error instanceof RemoteHostError) return error.toJSON();
  return new RemoteHostError("execution_unknown", "The operation did not return a verified result.", "execution").toJSON();
}
