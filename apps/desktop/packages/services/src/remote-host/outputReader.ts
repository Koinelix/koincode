import { constants } from "node:fs";
import { lstat, realpath, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { REMOTE_HOST_LIMITS, RemoteHostError, type RemoteExecutionOutputCursor, type RemoteExecutionOutputPage } from "@fcode/shared";
import { remoteExecutionOutputPath } from "./outputStore.js";

const frameSchema = z.strictObject({ stream: z.enum(["stdout", "stderr"]),
  text: z.string().refine((value) => !/[\uD800-\uDFFF]/u.test(value), "Output text contains an unpaired surrogate") });
const changed = () => new RemoteHostError("revision_conflict", "The local output changed. Reload its first page.", "storage");
const invalid = () => new RemoteHostError("storage_corrupt", "The local output is not a valid private JSONL artifact.", "storage");
const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

async function entry(root: string, executionId: string, attempt: number) {
  try {
    const before = await lstat(root); if (!before.isDirectory() || before.isSymbolicLink()) throw invalid();
    const canonicalRoot = await realpath(root); const after = await lstat(root);
    if (before.dev !== after.dev || before.ino !== after.ino || after.isSymbolicLink()) throw changed();
    const path = remoteExecutionOutputPath(join(canonicalRoot), executionId, attempt);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > REMOTE_HOST_LIMITS.outputBytes) throw invalid();
    return { path, info };
  } catch (error) { if (missing(error)) return null; throw error; }
}

/** Only a resolver-generated ordinary output entry can be removed; no directory traversal or recursive deletion. */
export async function removeRemoteExecutionOutput(root: string, executionId: string, attempt: number): Promise<void> {
  const found = await entry(root, executionId, attempt);
  if (!found) return;
  try { await unlink(found.path); } catch (error) { if (!missing(error)) throw error; }
}

function splitSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1); const after = text.charCodeAt(offset);
  return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF;
}

function fragmentEnd(text: string, start: number, stream: "stdout" | "stderr", budget: number): number {
  let low = start; let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2); const end = splitSurrogate(text, middle) ? middle - 1 : middle;
    if (Buffer.byteLength(JSON.stringify({ stream, text: text.slice(start, end) })) <= budget) low = middle; else high = middle - 1;
  }
  return splitSurrogate(text, low) ? low - 1 : low;
}

export async function readRemoteExecutionOutput(root: string, executionId: string, attempt: number, artifactId: string,
  cursor: RemoteExecutionOutputCursor | undefined, limit: number, signal: AbortSignal): Promise<RemoteExecutionOutputPage> {
  if (!Number.isSafeInteger(limit) || limit < 512 || limit > 16 * 1024) throw new RemoteHostError("invalid_request", "Invalid local output page budget.");
  const empty: RemoteExecutionOutputPage = { artifactId, available: false, expired: false, fileBytes: 0, entries: [], incompleteTail: false };
  const found = await entry(root, executionId, attempt); if (!found) return empty;
  signal.throwIfAborted();
  const handle = await open(found.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.ino !== found.info.ino || info.dev !== found.info.dev || info.size > REMOTE_HOST_LIMITS.outputBytes) throw changed();
    bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const value = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (!value.bytesRead) throw changed(); offset += value.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino || after.nlink !== 1) throw changed();
  } finally { await handle.close(); }
  signal.throwIfAborted();
  const version = createHash("sha256").update(bytes).digest("hex");
  if (cursor && (cursor.artifactId !== artifactId || cursor.version !== version)) throw changed();
  let offset = cursor?.byteOffset ?? 0; let characterOffset = cursor?.characterOffset ?? 0;
  if (offset > bytes.length || offset > 0 && bytes[offset - 1] !== 10 || offset === bytes.length && characterOffset) {
    throw new RemoteHostError("invalid_request", "The output cursor is not at a record boundary.");
  }
  const entries: RemoteExecutionOutputPage["entries"] = []; let used = 2;
  for (let frames = 0; offset < bytes.length && frames < 64; frames++) {
    signal.throwIfAborted();
    const end = bytes.indexOf(10, offset); if (end < 0) { offset = bytes.length; break; }
    let frame: z.infer<typeof frameSchema>;
    try { frame = frameSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end)))); }
    catch { throw invalid(); }
    if (characterOffset > frame.text.length || splitSurrogate(frame.text, characterOffset)) throw new RemoteHostError("invalid_request", "The output cursor splits a text character.");
    if (characterOffset === frame.text.length) { offset = end + 1; characterOffset = 0; continue; }
    const textEnd = fragmentEnd(frame.text, characterOffset, frame.stream, limit - used - 1);
    if (textEnd === characterOffset) break;
    const item = { stream: frame.stream, text: frame.text.slice(characterOffset, textEnd) };
    entries.push(item); used += Buffer.byteLength(JSON.stringify(item)) + 1;
    if (textEnd < frame.text.length) { characterOffset = textEnd; break; }
    offset = end + 1; characterOffset = 0;
  }
  return { artifactId, available: true, expired: false, fileBytes: bytes.length, entries, version,
    incompleteTail: bytes.length > 0 && bytes.at(-1) !== 10,
    ...(offset < bytes.length ? { nextCursor: { artifactId, version, byteOffset: offset, characterOffset } } : {}) };
}
