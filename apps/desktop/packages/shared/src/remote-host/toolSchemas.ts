import { z } from "zod";
import { remoteIdSchema, remotePathSchema, remoteHashSchema, remoteExecInputSchema, remoteUploadInputSchema, remoteRetryReferenceSchema } from "./contracts.js";
import { REMOTE_HOST_LIMITS, REMOTE_HOST_TOOLS } from "./limits.js";

export type RemoteHostToolName = (typeof REMOTE_HOST_TOOLS)[number];
const pageLimit = z.number().int().min(1).max(REMOTE_HOST_LIMITS.maxPageSize).default(REMOTE_HOST_LIMITS.pageSize);
const executionIds = z.array(remoteIdSchema).min(1).max(REMOTE_HOST_LIMITS.hostCount);

export const remoteHostToolSchemas = {
  get_remote_context: z.strictObject({ hostCursor: remoteIdSchema.nullable().default(null).describe("Use null for the first page. For later pages copy hostCursor from this tool response verbatim; never invent a cursor or use 0."),
    sourceCursor: remoteIdSchema.nullable().default(null).describe("Use null for the first page. For later pages copy sourceCursor from this tool response verbatim; never invent a cursor or use 0."),
    limit: z.number().int().min(1).max(REMOTE_HOST_LIMITS.pageSize).default(REMOTE_HOST_LIMITS.pageSize) }),
  list_directory: z.strictObject({ hostId: remoteIdSchema, path: remotePathSchema,
    retryOf: remoteRetryReferenceSchema.optional(),
    cursor: remoteIdSchema.optional(), limit: pageLimit }),
  read_file: z.strictObject({ hostId: remoteIdSchema, path: remotePathSchema,
    retryOf: remoteRetryReferenceSchema.optional(),
    offset: z.number().int().nonnegative().default(0),
    maxBytes: z.number().int().min(1).max(REMOTE_HOST_LIMITS.textBytes).default(REMOTE_HOST_LIMITS.modelBytes) }),
  write_file: z.strictObject({ requestId: remoteIdSchema,
    targets: z.array(z.strictObject({ hostId: remoteIdSchema, path: remotePathSchema,
      retryOf: remoteRetryReferenceSchema.optional(),
      expectedHash: remoteHashSchema.nullable(), ifExists: z.enum(["fail", "overwrite"]).default("fail") }))
      .min(1).max(REMOTE_HOST_LIMITS.hostCount),
    content: z.string().max(REMOTE_HOST_LIMITS.textBytes).refine(
      (value) => new TextEncoder().encode(value).byteLength <= REMOTE_HOST_LIMITS.textBytes, "Text exceeds the byte limit"),
  }),
  upload: remoteUploadInputSchema,
  exec: remoteExecInputSchema,
  get_execution: z.strictObject({ executionIds, afterSequence: z.number().int().nonnegative().default(0),
    waitMs: z.number().int().nonnegative().max(REMOTE_HOST_LIMITS.pollMs).default(0) }),
  cancel_execution: z.strictObject({ requestId: remoteIdSchema, executionIds }),
};

export function parseRemoteToolInput(name: RemoteHostToolName, input: unknown): Record<string, unknown> {
  return remoteHostToolSchemas[name].parse(input) as Record<string, unknown>;
}
