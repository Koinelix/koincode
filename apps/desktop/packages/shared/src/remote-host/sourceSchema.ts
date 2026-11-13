import { z } from "zod";
import { remoteBindingSchema, remoteHashSchema, remoteIdSchema, remotePathSchema } from "./contracts.js";
import { REMOTE_HOST_LIMITS } from "./limits.js";

const relativePath = remotePathSchema.refine((value) => !value.startsWith("/") && !value.includes("\\") &&
  !value.split("/").some((part) => !part || part === ".."), "Invalid relative upload path");

export const remoteManifestEntrySchema = z.strictObject({
  type: z.enum(["file", "directory"]),
  relativePath,
  size: z.number().int().nonnegative().max(REMOTE_HOST_LIMITS.fileBytes),
  mode: z.number().int().nonnegative().max(0o777),
  sha256: remoteHashSchema.optional(),
}).superRefine((entry, context) => {
  if (entry.type === "file" && (!entry.sha256 || entry.relativePath === ".")) {
    context.addIssue({ code: "custom", message: "File entries require a content hash and a regular relative path" });
  }
  if (entry.type === "directory" && (entry.size !== 0 || entry.sha256 !== undefined)) {
    context.addIssue({ code: "custom", message: "Directory entries cannot contain file bytes or hashes" });
  }
});

export const remoteSourceRecordSchema = z.strictObject({
  sourceId: z.uuid(), snapshotId: z.uuid(),
  origin: z.enum(["picker", "attachment", "workspace_path"]),
  kind: z.enum(["file", "directory"]),
  displayName: remotePathSchema,
  ownerId: remoteIdSchema,
  workspaceKey: remotePathSchema,
  binding: remoteBindingSchema,
  originalPath: remotePathSchema,
  fileCount: z.number().int().nonnegative().max(REMOTE_HOST_LIMITS.fileCount),
  directoryCount: z.number().int().nonnegative().max(REMOTE_HOST_LIMITS.scannedEntries),
  totalBytes: z.number().int().nonnegative().max(REMOTE_HOST_LIMITS.sourceBytes),
  skippedCount: z.number().int().nonnegative().max(REMOTE_HOST_LIMITS.scannedEntries),
  manifestHash: remoteHashSchema,
  frozenAt: z.number().int().nonnegative(),
  availability: z.enum(["ready", "requires_confirmation", "expired"]),
  entries: z.array(remoteManifestEntrySchema).max(REMOTE_HOST_LIMITS.scannedEntries),
  skipped: z.array(z.strictObject({ relativePath: z.string().max(REMOTE_HOST_LIMITS.pathBytes), reason: remoteIdSchema }))
    .max(REMOTE_HOST_LIMITS.scannedEntries),
  callId: remoteIdSchema.optional(),
}).superRefine((source, context) => {
  const files = source.entries.filter((entry) => entry.type === "file");
  if (source.fileCount !== files.length || source.directoryCount !== source.entries.length - files.length ||
    source.totalBytes !== files.reduce((total, entry) => total + entry.size, 0) || source.skippedCount !== source.skipped.length ||
    new Set(source.entries.map((entry) => entry.relativePath)).size !== source.entries.length) {
    context.addIssue({ code: "custom", message: "The source summary does not match its manifest" });
  }
});
