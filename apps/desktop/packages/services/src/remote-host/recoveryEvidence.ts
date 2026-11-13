import { z } from "zod";
import { REMOTE_HOST_LIMITS, remoteIdSchema, remotePathSchema, remoteHashSchema, remoteManifestEntrySchema } from "@fcode/shared";
import type { RemotePreparedCall, RemotePreparedTarget } from "./preparedTypes.js";

export const remoteRecoveryEvidenceSchema = z.strictObject({
  hostId: remoteIdSchema,
  remotePath: remotePathSchema,
  ifExists: z.enum(["fail", "overwrite", "merge", "replace"]),
  previousExists: z.boolean(), previousDigest: remoteHashSchema,
  manifest: z.array(remoteManifestEntrySchema).min(1).max(REMOTE_HOST_LIMITS.scannedEntries),
});
export type RemoteRecoveryEvidence = z.infer<typeof remoteRecoveryEvidenceSchema>;

export function remoteRecoveryEvidence(prepared: RemotePreparedCall, target: RemotePreparedTarget): RemoteRecoveryEvidence | null {
  if (prepared.operation !== "upload" || !target.path || !prepared.entries?.length || target.error) return null;
  return remoteRecoveryEvidenceSchema.parse({ hostId: target.host.hostId, remotePath: target.path,
    ifExists: target.ifExists, previousExists: Boolean(target.condition?.stat), previousDigest: target.condition?.digest, manifest: prepared.entries });
}
