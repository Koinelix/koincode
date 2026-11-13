import { z } from "zod";
import { REMOTE_HOST_LIMITS } from "./limits.js";

// eslint-disable-next-line no-control-regex -- SSH fields must reject control characters.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const MAX_ID_LENGTH = 256;
const MAX_HOST_LENGTH = 253;
const MAX_NAME_LENGTH = 100;
const MAX_SECRET_LENGTH = 32768;

export const remoteIdSchema = z.string().min(1).max(MAX_ID_LENGTH).refine(
  (value) => !CONTROL_CHARACTERS.test(value), "Invalid identifier",
);
export const remotePathSchema = z.string().min(1).max(REMOTE_HOST_LIMITS.pathBytes).refine(
  (value) => !CONTROL_CHARACTERS.test(value) && new TextEncoder().encode(value).byteLength <= REMOTE_HOST_LIMITS.pathBytes, "Invalid path",
);
export const remoteHashSchema = z.string().regex(SHA256_HEX);
export const remoteAuthTypeSchema = z.enum(["password", "private_key", "ssh_agent"]);
export const remotePersistenceSchema = z.enum(["session", "os_protected"]);
export const remoteEnvironmentSchema = z.enum(["development", "test", "production", "unspecified"]);

export function isRemoteHostAddress(value: string): boolean {
  if (CONTROL_CHARACTERS.test(value) || /[\s/@?#\\]/.test(value)) return false;
  if (value.includes(":")) {
    try {
      return new URL(`ssh://[${value}]`).hostname.length > 0;
    } catch {
      return false;
    }
  }
  if (/^[\d.]+$/.test(value)) {
    const parts = value.split(".");
    return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  }
  return value.length <= MAX_HOST_LENGTH && value.split(".").every(
    (part) => part.length <= 63 && HOST_LABEL.test(part),
  );
}

export const remoteHostConfigSchema = z.strictObject({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH).refine((value) => !CONTROL_CHARACTERS.test(value)),
  host: z.string().trim().min(1).max(MAX_HOST_LENGTH).refine(isRemoteHostAddress, "Invalid SSH address"),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(128).refine((value) => !CONTROL_CHARACTERS.test(value)),
  environment: remoteEnvironmentSchema.default("unspecified"),
  group: z.string().trim().max(MAX_NAME_LENGTH).default(""),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  authType: remoteAuthTypeSchema,
  privateKeyPath: remotePathSchema.optional(),
  agentPath: remotePathSchema.optional(),
  secretPersistence: remotePersistenceSchema.default("session"),
  defaultCwd: remotePathSchema.refine((value) => value.startsWith("/")).optional(),
  fileRoots: z.array(remotePathSchema.refine((value) => value.startsWith("/"))).max(20).default([]),
  enabled: z.boolean().default(true),
}).superRefine((value, context) => {
  if (value.authType === "private_key" && !value.privateKeyPath) {
    context.addIssue({ code: "custom", path: ["privateKeyPath"], message: "A private key path is required" });
  }
  if (value.authType !== "private_key" && value.privateKeyPath) {
    context.addIssue({ code: "custom", path: ["privateKeyPath"], message: "Unexpected private key path" });
  }
  if (value.authType !== "ssh_agent" && value.agentPath) {
    context.addIssue({ code: "custom", path: ["agentPath"], message: "Unexpected agent path" });
  }
});

export const remoteSecretMaterialSchema = z.strictObject({
  password: z.string().min(1).max(MAX_SECRET_LENGTH).optional(),
  passphrase: z.string().min(1).max(MAX_SECRET_LENGTH).optional(),
});
export const remoteSecretUpdateSchema = z.discriminatedUnion("intent", [
  z.strictObject({ intent: z.literal("keep") }),
  z.strictObject({ intent: z.literal("clear") }),
  z.strictObject({ intent: z.literal("replace"), material: remoteSecretMaterialSchema }),
]);
export const remoteHostSaveSchema = z.strictObject({
  requestId: remoteIdSchema,
  hostId: remoteIdSchema.optional(),
  expectedRevision: z.number().int().positive().optional(),
  config: remoteHostConfigSchema,
  secret: remoteSecretUpdateSchema,
});

export const remoteHostRecordSchema = z.strictObject({
  hostId: remoteIdSchema,
  revision: z.number().int().positive(),
  securityRevision: z.number().int().positive(),
  credentialVersion: z.number().int().nonnegative(),
  credentialRequired: z.boolean(),
  config: remoteHostConfigSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastCheckedAt: z.number().int().nonnegative().optional(),
  lastCheckResult: z.enum(["success", "failed"]).optional(),
});
export const remoteTrustRecordSchema = z.strictObject({
  hostId: remoteIdSchema,
  endpoint: z.string().min(1).max(512),
  publicKey: z.string().min(1).max(MAX_SECRET_LENGTH),
  keyType: z.string().min(1).max(128),
  fingerprint: z.string().startsWith("SHA256:").max(128),
  trustRevision: z.number().int().positive(),
  acceptedAt: z.number().int().nonnegative(),
});

export const remoteBindingSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("draft"), draftId: remoteIdSchema }),
  z.strictObject({ kind: z.literal("session"), sessionId: remoteIdSchema }),
]);
export const remoteSelectionSchema = z.strictObject({
  selectionId: remoteIdSchema,
  requestId: remoteIdSchema,
  submissionId: remoteIdSchema,
  ownerId: remoteIdSchema,
  workspaceKey: z.string().min(1).max(REMOTE_HOST_LIMITS.pathBytes),
  binding: remoteBindingSchema,
  targets: z.array(z.strictObject({
    hostId: remoteIdSchema,
    securityRevision: z.number().int().positive(),
    trustRevision: z.number().int().nonnegative(),
    displayName: z.string().min(1).max(MAX_NAME_LENGTH),
  })).min(1).max(REMOTE_HOST_LIMITS.hostCount),
  sourceIds: z.array(remoteIdSchema).max(REMOTE_HOST_LIMITS.fileCount),
  createdAt: z.number().int().nonnegative(),
});

export const remoteRetryReferenceSchema = z.strictObject({ executionId: remoteIdSchema, attempt: z.number().int().positive() })
  .describe("For an explicit user-requested retry, copy the original executionId and attempt. Use a new requestId and fresh approvals. Unknown outcomes require reconciliation first.");

export const remoteUploadInputSchema = z.strictObject({
  requestId: remoteIdSchema,
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("source_id"), sourceId: remoteIdSchema }),
    z.strictObject({ kind: z.literal("workspace_path"), path: remotePathSchema }),
  ]),
  targets: z.array(z.strictObject({
    hostId: remoteIdSchema,
    remotePath: remotePathSchema,
    retryOf: remoteRetryReferenceSchema.optional(),
    ifExists: z.enum(["fail", "merge", "overwrite", "replace"]).default("fail"),
  })).min(1).max(REMOTE_HOST_LIMITS.hostCount),
  exclude: z.array(z.string().min(1).max(REMOTE_HOST_LIMITS.pathBytes)).max(200).default([]),
});

const shellSchema = z.string().min(1).max(REMOTE_HOST_LIMITS.textBytes).refine((value) => !value.includes("\0"));
const shellEnvironmentSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().max(MAX_SECRET_LENGTH).refine((value) => !value.includes("\0")),
);
const shellFields = {
  command: shellSchema,
  cwd: remotePathSchema.optional(),
  env: shellEnvironmentSchema.optional(),
};
export const remoteExecInputSchema = z.strictObject({
  requestId: remoteIdSchema,
  targets: z.array(z.strictObject({
    hostId: remoteIdSchema, ...shellFields,
    retryOf: remoteRetryReferenceSchema.optional(),
    verify: z.strictObject(shellFields).optional(),
  })).min(1).max(REMOTE_HOST_LIMITS.hostCount),
  timeoutMs: z.number().int().positive().max(REMOTE_HOST_LIMITS.maxExecutionMs).default(REMOTE_HOST_LIMITS.commandMs),
  stopOnFailure: z.boolean().default(false),
});

export const remoteExecutionStateSchema = z.enum([
  "preparing", "preflight", "awaiting_approval", "queued", "dispatching", "running",
  "verifying", "succeeded", "failed", "cancel_requested", "canceled",
  "execution_unknown", "reconciling", "needs_review",
]);
export const remoteOperationSchema = z.enum(["list_directory", "read_file", "write_file", "upload", "exec"]);
export const remoteUploadStageSchema = z.enum([
  "staging", "staged_verified", "backup_intent", "backed_up",
  "publish_intent", "published", "final_verified",
]);

export type RemoteHostConfig = z.infer<typeof remoteHostConfigSchema>;
export type RemoteHostSave = z.infer<typeof remoteHostSaveSchema>;
export type RemoteSecretMaterial = z.infer<typeof remoteSecretMaterialSchema>;
export type RemoteHostRecord = z.infer<typeof remoteHostRecordSchema>;
export type RemoteTrustRecord = z.infer<typeof remoteTrustRecordSchema>;
export type RemoteSelection = z.infer<typeof remoteSelectionSchema>;
export type RemoteUploadInput = z.infer<typeof remoteUploadInputSchema>;
export type RemoteExecInput = z.infer<typeof remoteExecInputSchema>;
export type RemoteExecutionState = z.infer<typeof remoteExecutionStateSchema>;
export type RemoteOperation = z.infer<typeof remoteOperationSchema>;
export type RemoteUploadStage = z.infer<typeof remoteUploadStageSchema>;
