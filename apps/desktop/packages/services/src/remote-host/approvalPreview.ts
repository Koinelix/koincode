import type { RemotePreparedCall } from "./preparedTypes.js";
import { remoteEndpoint } from "./hostCatalog.js";
import { publicRemoteSource } from "./sourceSummary.js";

/** Private permission presentation, never injected into tool arguments or model context. */
export function remoteApprovalPreview(prepared: RemotePreparedCall): Record<string, unknown> {
  return { preparedCallId: prepared.preparedCallId, operation: prepared.operation,
    timeoutMs: prepared.timeoutMs, stopOnFailure: prepared.stopOnFailure,
    targets: prepared.targets.map((target) => ({ hostId: target.host.hostId, name: target.host.config.name,
      endpoint: remoteEndpoint(target.host.config), username: target.host.config.username,
      environment: target.host.config.environment, securityRevision: target.host.securityRevision, trustRevision: target.trustRevision, ...(target.error ? { error: target.error } : {}),
      ...(target.path ? { path: target.path, exists: Boolean(target.condition?.stat), ifExists: target.ifExists,
        overwriteCount: target.overwriteCount ?? 0, overwriteExamples: target.overwriteExamples ?? [],
        spaceVerified: target.availableBytes !== null && target.availableBytes !== undefined } : {}),
      ...(target.command ? { command: target.command } : {}), ...(target.verify ? { verify: target.verify } : {}),
      ...(target.retryOf ? { retryOf: target.retryOf, attempt: target.retryOf.attempt + 1 } : {}),
    })), ...(prepared.source ? { source: publicRemoteSource(prepared.source), localSourcePath: prepared.source.originalPath,
      effectiveManifestHash: prepared.effectiveManifestHash,
      effectiveFileCount: prepared.entries?.filter((entry) => entry.type === "file").length,
      effectiveBytes: prepared.entries?.reduce((total, entry) => total + entry.size, 0),
      skipped: prepared.source.skipped.slice(0, 50), skippedTotal: prepared.source.skipped.length } : {}),
    ...(prepared.operation === "write_file" ? { content: prepared.input.content } : {}) };
}
