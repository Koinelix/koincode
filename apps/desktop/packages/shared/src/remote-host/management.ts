import { z } from "zod";
import { remoteIdSchema, remotePathSchema, remoteHashSchema, remoteBindingSchema, remoteHostSaveSchema, remoteSelectionSchema } from "./contracts.js";
import { REMOTE_HOST_LIMITS } from "./limits.js";
import type { RemoteHostSummary, RemoteHostPage, RemoteTestResult, RemoteHostChallenge, RemoteUploadSource,
  RemoteExecutionRecord } from "./types.js";

const revisionTarget = z.strictObject({ hostId: remoteIdSchema, expectedRevision: z.number().int().positive() });
const sourceBinding = { workspaceKey: remotePathSchema, binding: remoteBindingSchema };
const operation = { operationId: remoteIdSchema };
export const remoteExecutionOutputCursorSchema = z.strictObject({ artifactId: remoteIdSchema, version: remoteHashSchema,
  byteOffset: z.number().int().min(0).max(REMOTE_HOST_LIMITS.outputBytes), characterOffset: z.number().int().min(0).max(REMOTE_HOST_LIMITS.outputBytes) });
export const remoteHostManagementSchemas = {
  getCapabilities: z.strictObject({}),
  getSessionAuthorization: z.strictObject({ workspaceKey: remotePathSchema, sessionId: remoteIdSchema }),
  revokeSessionAuthorization: z.strictObject({ workspaceKey: remotePathSchema, sessionId: remoteIdSchema }),
  listHosts: z.strictObject({ query: z.string().max(500).optional(), group: z.string().max(100).optional(),
    enabled: z.boolean().optional(), cursor: remoteIdSchema.optional(),
    limit: z.number().int().min(1).max(REMOTE_HOST_LIMITS.maxPageSize).optional() }),
  saveHost: remoteHostSaveSchema,
  deleteHosts: z.strictObject({ requestId: remoteIdSchema, targets: z.array(revisionTarget).min(1).max(REMOTE_HOST_LIMITS.hostCount) }),
  updateHosts: z.strictObject({ requestId: remoteIdSchema, targets: z.array(revisionTarget).min(1).max(REMOTE_HOST_LIMITS.hostCount),
    patch: z.strictObject({ enabled: z.boolean().optional(), group: z.string().max(100).optional(),
      tags: z.array(z.string().max(64)).max(20).optional() }).refine((value) => Object.keys(value).length > 0) }),
  testConnections: z.strictObject({ ...operation, targets: z.array(z.strictObject({ hostId: remoteIdSchema,
    securityRevision: z.number().int().positive() })).min(1).max(REMOTE_HOST_LIMITS.hostCount) }),
  acceptHostKey: z.strictObject({ challengeId: remoteIdSchema, action: z.enum(["trust_initial", "replace_changed_key"]) }),
  chooseUploadSource: z.strictObject({ ...sourceBinding, ...operation, kind: z.enum(["file", "directory"]) }),
  addUploadAttachments: z.strictObject({ ...sourceBinding, ...operation, purpose: z.literal("remote_upload"),
    paths: z.array(remotePathSchema).min(1).max(8).refine((paths) => new Set(paths).size === paths.length, "Duplicate attachment paths are not allowed") }),
  listUploadSources: z.strictObject({ ...sourceBinding, cursor: remoteIdSchema.optional(),
    limit: z.number().int().min(1).max(REMOTE_HOST_LIMITS.maxPageSize).default(50) }),
  confirmUploadSource: z.strictObject({ ...sourceBinding, ...operation, sourceId: remoteIdSchema,
    expectedManifestHash: z.string().regex(/^[a-f0-9]{64}$/), expectedFrozenAt: z.number().int().nonnegative() }),
  removeUploadSource: z.strictObject({ sourceId: remoteIdSchema, ...sourceBinding }),
  cancelManagementOperation: z.strictObject(operation),
  bindMessageSelection: z.strictObject({ requestId: remoteIdSchema, submissionId: remoteIdSchema, ...sourceBinding,
    targets: z.array(z.strictObject({ hostId: remoteIdSchema, securityRevision: z.number().int().positive(),
      trustRevision: z.number().int().nonnegative() })).min(1).max(REMOTE_HOST_LIMITS.hostCount),
    sourceIds: z.array(remoteIdSchema).max(REMOTE_HOST_LIMITS.fileCount) }),
  listExecutions: z.strictObject({ workspaceKey: remotePathSchema, sessionId: remoteIdSchema,
    cursor: remoteIdSchema.optional(), limit: z.number().int().min(1).max(REMOTE_HOST_LIMITS.pageSize).default(REMOTE_HOST_LIMITS.pageSize) }),
  readExecutionOutput: z.strictObject({ workspaceKey: remotePathSchema, sessionId: remoteIdSchema, executionId: remoteIdSchema,
    artifactId: remoteIdSchema, cursor: remoteExecutionOutputCursorSchema.optional(), limit: z.number().int().min(512).max(16 * 1024).default(16 * 1024) }),
  cancelExecution: z.strictObject({ workspaceKey: remotePathSchema, sessionId: remoteIdSchema,
    executionIds: z.array(remoteIdSchema).min(1).max(REMOTE_HOST_LIMITS.hostCount), requestId: remoteIdSchema }),
  prepareReconciliation: z.strictObject({ workspaceKey: remotePathSchema, sessionId: remoteIdSchema, executionId: remoteIdSchema }),
  reconcileExecution: z.strictObject({ workspaceKey: remotePathSchema, sessionId: remoteIdSchema, reconciliationId: remoteIdSchema }),
};
export type RemoteHostManagementMethod = keyof typeof remoteHostManagementSchemas;
export type RemoteCancellableManagementMethod = "testConnections" | "chooseUploadSource" | "addUploadAttachments" | "confirmUploadSource";
export const remoteHostManagementRequestSchema = z.strictObject({
  method: z.enum(Object.keys(remoteHostManagementSchemas) as [RemoteHostManagementMethod, ...RemoteHostManagementMethod[]]), input: z.unknown(),
});
export type RemoteHostManagementInput<M extends RemoteHostManagementMethod> = z.input<(typeof remoteHostManagementSchemas)[M]>;
export interface RemoteHostCapabilities {
  protocolVersion: number;
  ownerId: string;
  brokerGeneration: string;
  executionAvailable: boolean;
  executionUnavailableReason?: import("./platformSupport.js").RemoteHostExecutionUnavailableReason;
  pluginAvailable: boolean;
  canSelectFilePath: boolean;
  secretStorage: { available: boolean; backend: string; reason?: string };
}
export interface RemoteHostManagementOutput {
  getCapabilities: RemoteHostCapabilities;
  getSessionAuthorization: import("./sessionAuthorization.js").RemoteSessionAuthorizationStatus;
  revokeSessionAuthorization: { revoked: boolean };
  listHosts: RemoteHostPage;
  saveHost: RemoteHostSummary;
  deleteHosts: Array<{ hostId: string; success: boolean; error?: import("./errors.js").RemoteHostFailure }>;
  updateHosts: Array<{ hostId: string; success: boolean; host?: RemoteHostSummary; error?: import("./errors.js").RemoteHostFailure }>;
  testConnections: RemoteTestResult[];
  acceptHostKey: { hostId: string; trustRevision: number };
  chooseUploadSource: RemoteUploadSource | null;
  addUploadAttachments: { sources: RemoteUploadSource[]; failures: Array<{ path: string; error: import("./errors.js").RemoteHostFailure }> };
  listUploadSources: { items: RemoteUploadSourcePreview[]; nextCursor?: string };
  confirmUploadSource: RemoteUploadSource;
  removeUploadSource: { removed: boolean };
  cancelManagementOperation: { cancelRequested: boolean };
  bindMessageSelection: z.infer<typeof remoteSelectionSchema>;
  listExecutions: { items: RemoteExecutionRecord[]; nextCursor?: string; liveRemoteTurn: boolean; maintenancePending?: boolean };
  readExecutionOutput: RemoteExecutionOutputPage;
  cancelExecution: RemoteExecutionRecord[];
  prepareReconciliation: RemoteReconciliationPreview;
  reconcileExecution: RemoteExecutionRecord;
}
/** Local management preview only; original paths never enter model-facing source metadata. */
export interface RemoteUploadSourcePreview extends RemoteUploadSource { originalPath: string }
export type RemoteExecutionOutputCursor = z.infer<typeof remoteExecutionOutputCursorSchema>;
export interface RemoteExecutionOutputPage {
  artifactId: string; available: boolean; expired: boolean; fileBytes: number; incompleteTail: boolean;
  version?: string;
  entries: Array<{ stream: "stdout" | "stderr"; text: string }>;
  nextCursor?: RemoteExecutionOutputCursor; maintenancePending?: boolean;
}
export interface RemoteReconciliationPreview {
  reconciliationId: string;
  executionId: string;
  display: RemoteExecutionRecord["display"];
  paths: string[];
  expiresAt: number;
  canVerifyPublication: boolean;
}
export interface RemoteHostManagementClient {
  request<M extends RemoteHostManagementMethod>(method: M, input: RemoteHostManagementInput<M>): Promise<RemoteHostManagementOutput[M]>;
}
export type RemoteHostTrustPrompt = RemoteHostChallenge;
