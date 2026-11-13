import { createHash } from "node:crypto";
import { REMOTE_HOST_LIMITS, RemoteHostError, remoteHostToolSchemas, type RemoteSftpPort } from "@fcode/shared";
import type { RemotePreparedCall, RemotePreparedTarget } from "./preparedTypes.js";
import { remoteInputDigest } from "./canonicalInput.js";
import { RemoteUtf8TextValidator, REMOTE_UTF8_PAGE_LOOKAHEAD, remoteUtf8TextPage } from "./utf8Text.js";

export async function runRemoteStructuredRead(prepared: RemotePreparedCall, target: RemotePreparedTarget,
  files: RemoteSftpPort, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (prepared.operation === "list_directory") {
    const input = remoteHostToolSchemas.list_directory.parse(prepared.input);
    let offset = 0;
    if (input.cursor) {
      let cursor: unknown;
      try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString()); } catch { /* Rejected below. */ }
      if (!Array.isArray(cursor) || cursor.length !== 2 || cursor[0] !== target.condition?.digest ||
        !Number.isSafeInteger(cursor[1]) || cursor[1] < 0 || cursor[1] > REMOTE_HOST_LIMITS.scannedEntries) {
        throw new RemoteHostError("preflight_changed", "The directory cursor is invalid or stale.");
      }
      offset = cursor[1];
    }
    const page = await files.list(target.path!, offset, input.limit, signal);
    const items: typeof page.entries = [];
    for (const entry of page.entries) {
      if (Buffer.byteLength(JSON.stringify(items)) + Buffer.byteLength(JSON.stringify(entry)) > REMOTE_HOST_LIMITS.modelBytes - 1024) break;
      items.push(entry);
    }
    const next = items.length < page.entries.length ? offset + items.length : page.nextOffset;
    return { path: target.path, entries: items,
      ...(next !== undefined ? { nextCursor: Buffer.from(JSON.stringify([target.condition!.digest, next])).toString("base64url") } : {}) };
  }
  const input = remoteHostToolSchemas.read_file.parse(prepared.input);
  const before = await files.stat(target.path!);
  if (!before || before.type !== "file") throw new RemoteHostError("preflight_changed", "The remote file changed type.");
  if (before.size > REMOTE_HOST_LIMITS.textBytes) throw new RemoteHostError("output_limit", "Use upload for files larger than the structured text limit.");
  if (input.offset > before.size) throw new RemoteHostError("invalid_request", "The read offset exceeds the file size.");
  const limit = Math.min(input.maxBytes, Math.floor((REMOTE_HOST_LIMITS.modelBytes - 2048) / 6));
  const hash = createHash("sha256");
  const validator = new RemoteUtf8TextValidator();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const bytes of files.read(target.path!, REMOTE_HOST_LIMITS.textBytes, signal)) {
    const chunk = Buffer.from(bytes); hash.update(chunk); validator.push(chunk);
    const start = Math.max(0, input.offset - total);
    const end = Math.min(chunk.length, input.offset + limit + REMOTE_UTF8_PAGE_LOOKAHEAD - total);
    if (end > start) chunks.push(chunk.subarray(start, end));
    total += chunk.length;
  }
  validator.finish();
  const after = await files.stat(target.path!);
  if (!after || total !== before.size || remoteInputDigest(before) !== remoteInputDigest(after)) throw new RemoteHostError("preflight_changed", "The file changed during its read.");
  const content = remoteUtf8TextPage(Buffer.concat(chunks), limit);
  return { path: target.path, text: content.toString("utf8"), sha256: hash.digest("hex"), size: total, offset: input.offset,
    ...(input.offset + content.length < total ? { nextOffset: input.offset + content.length } : {}) };
}
