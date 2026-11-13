import { constants, createWriteStream } from "node:fs";
import { open, mkdir, lstat, realpath } from "node:fs/promises";
import { dirname, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { REMOTE_HOST_LIMITS, RemoteHostError } from "@fcode/shared";
import { protectRemoteHostPath } from "./privatePaths.js";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export function pathInside(root: string, candidate: string): boolean {
  const part = relative(root, candidate);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}

export async function freezeRemoteFile(input: {
  original: string;
  destination: string;
  sourceRoot: string;
  signal?: AbortSignal;
  maxBytes: number;
}): Promise<{ size: number; sha256: string; mode: number }> {
  input.signal?.throwIfAborted();
  const before = await lstat(input.original);
  if (!before.isFile() || !pathInside(input.sourceRoot, await realpath(input.original))) {
    throw new RemoteHostError("source_changed", "The upload source was replaced or moved outside its allowed root.");
  }
  if (before.size > Math.min(input.maxBytes, REMOTE_HOST_LIMITS.fileBytes)) {
    throw new RemoteHostError("transfer_limit", "The upload source exceeds its size limit.");
  }
  const handle = await open(input.original, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) {
      throw new RemoteHostError("source_changed", "The upload source changed before it could be read.");
    }
    await mkdir(dirname(input.destination), { recursive: true, mode: DIRECTORY_MODE });
    const digest = createHash("sha256");
    let bytes = 0;
    const hashing = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > Math.min(input.maxBytes, REMOTE_HOST_LIMITS.fileBytes)) {
        callback(new RemoteHostError("transfer_limit", "The upload source grew beyond its size limit."));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    } });
    await pipeline(handle.createReadStream({ start: 0, autoClose: false }), hashing,
      createWriteStream(input.destination, { flags: "wx", mode: FILE_MODE }), { signal: input.signal });
    await protectRemoteHostPath(input.destination, false);
    const copiedHash = digest.digest("hex");
    const verifyHash = createHash("sha256");
    let verifiedBytes = 0;
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
      input.signal?.throwIfAborted();
      verifiedBytes += (chunk as Buffer).length;
      if (verifiedBytes > bytes) throw new RemoteHostError("source_changed", "The source grew during its final content check.");
      verifyHash.update(chunk);
    }
    const after = await handle.stat();
    const current = await lstat(input.original);
    if (before.size !== bytes || verifiedBytes !== bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink() ||
      copiedHash !== verifyHash.digest("hex")) {
      throw new RemoteHostError("source_changed", "The upload source changed while its snapshot was being created.");
    }
    return { size: bytes, sha256: copiedHash, mode: before.mode };
  } finally { await handle.close(); }
}
