import type { RemoteSourceRecord, RemoteUploadSource } from "@fcode/shared";

export function publicRemoteSource(source: RemoteSourceRecord): RemoteUploadSource {
  const { sourceId, origin, kind, displayName, fileCount, directoryCount, totalBytes,
    skippedCount, manifestHash, frozenAt, availability } = source;
  return { sourceId, origin, kind, displayName, fileCount, directoryCount, totalBytes, skippedCount, manifestHash, frozenAt, availability };
}
