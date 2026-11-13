import { z } from "zod";
import { remoteIdSchema, remotePathSchema, remoteHashSchema, remoteExecutionStateSchema,
  remoteOperationSchema, remoteUploadStageSchema } from "./contracts.js";
import { REMOTE_HOST_ERROR_CODES } from "./errors.js";
import { REMOTE_HOST_LIMITS } from "./limits.js";

const timestamp = z.number().int().nonnegative();
export const remoteClientPrincipalSchema = z.strictObject({
  ownerId: remoteIdSchema, clientInstanceId: remoteIdSchema, workspaceKey: remotePathSchema,
  agentGeneration: remoteIdSchema, brokerGeneration: remoteIdSchema,
});
export const remoteCallContextSchema = remoteClientPrincipalSchema.extend({
  traceId: remoteIdSchema, sessionId: remoteIdSchema, messageId: remoteIdSchema,
  turnId: remoteIdSchema, toolCallId: remoteIdSchema, runtimeScope: z.enum(["main", "subagent"]),
  selectionId: remoteIdSchema.optional(),
});
export const remoteHostFailureSchema = z.strictObject({
  code: z.enum(REMOTE_HOST_ERROR_CODES),
  stage: z.enum(["configuration", "trust", "authentication", "authorization", "connection", "execution", "verification", "storage"]),
  message: z.string().min(1).max(4096), retryable: z.boolean(), requiresUserAction: z.boolean(),
});
export const remoteExecutionRecordSchema = z.strictObject({
  executionId: remoteIdSchema, attempt: z.number().int().positive(),
  retryOf: z.strictObject({ executionId: remoteIdSchema, attempt: z.number().int().positive() }).optional(),
  context: remoteCallContextSchema, hostId: remoteIdSchema,
  securityRevision: z.number().int().positive(), trustRevision: z.number().int().nonnegative(),
  display: z.strictObject({ name: z.string().max(100), endpoint: z.string().max(512), username: z.string().max(128) }),
  operation: remoteOperationSchema, requestId: remoteIdSchema, approvalId: remoteIdSchema,
  operationDigest: remoteHashSchema, state: remoteExecutionStateSchema,
  createdAt: timestamp, updatedAt: timestamp, startedAt: timestamp.optional(), deadlineAt: timestamp.optional(),
  dispatchExpiresAt: timestamp, exitCode: z.number().int().optional(), signal: z.string().max(128).optional(),
  verification: z.enum(["not_requested", "verified", "failed", "unverified"]).optional(),
  cancelReason: z.string().max(512).optional(), error: remoteHostFailureSchema.optional(),
  uploadedBytes: z.number().int().nonnegative().optional(), uploadedFiles: z.number().int().nonnegative().optional(),
  sourceId: remoteIdSchema.optional(), snapshotId: remoteIdSchema.optional(), manifestHash: remoteHashSchema.optional(),
  remotePath: remotePathSchema.optional(), stagingPath: remotePathSchema.optional(), backupPath: remotePathSchema.optional(),
  receiptPath: remotePathSchema.optional(), uploadStage: remoteUploadStageSchema.optional(),
  residualPaths: z.array(remotePathSchema).max(REMOTE_HOST_LIMITS.scannedEntries).optional(),
  reconciliation: z.strictObject({ checkedAt: timestamp, reason: z.string().max(4096),
    checks: z.array(z.strictObject({ path: remotePathSchema, exists: z.boolean(),
      type: z.string().max(32).optional(), size: z.number().int().nonnegative().optional() })).max(4) }).optional(),
  outputBytes: z.number().int().nonnegative().max(REMOTE_HOST_LIMITS.outputBytes), outputTruncated: z.boolean(),
  outputArtifactId: remoteIdSchema.optional(), outputExpiredAt: timestamp.optional(),
  outputPurgedAt: timestamp.optional(), eventsPurgedAt: timestamp.optional(),
  result: z.record(z.string(), z.unknown()).refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= REMOTE_HOST_LIMITS.modelBytes,
    "The structured result exceeds its model budget").optional(),
});

export const remoteExecutionEventSchema = z.strictObject({
  eventVersion: z.literal(1), executionId: remoteIdSchema, hostId: remoteIdSchema,
  attempt: z.number().int().positive(), sequence: z.number().int().positive(), timestamp,
  traceId: remoteIdSchema, state: remoteExecutionStateSchema,
  uploadedBytes: z.number().int().nonnegative().optional(), uploadedFiles: z.number().int().nonnegative().optional(),
  message: z.string().max(4096).optional(),
});

export const remoteMessageBindingSchema = z.strictObject({
  selectionId: remoteIdSchema, sessionId: remoteIdSchema, messageId: remoteIdSchema,
  submissionId: remoteIdSchema, ownerId: remoteIdSchema, workspaceKey: remotePathSchema,
});
