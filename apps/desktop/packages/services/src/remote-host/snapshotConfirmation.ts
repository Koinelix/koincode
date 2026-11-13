import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { REMOTE_HOST_LIMITS, RemoteHostError, type RemoteSourceRecord } from "@fcode/shared";

/** Verify only the private, frozen tree. Never reopen the original user path. */
export async function verifyRemoteSnapshot(folder: string, source: RemoteSourceRecord, signal: AbortSignal): Promise<void> {
  const fail = () => new RemoteHostError("source_changed", "The frozen upload snapshot changed. Select the source again.");
  const expected = new Map(source.entries.map((entry) => [entry.relativePath === "." ? "" : entry.relativePath, entry]));
  const seen = new Set<string>(); let visited = 0;
  const walk = async (path: string, relativePath: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    if (++visited > REMOTE_HOST_LIMITS.scannedEntries || depth > REMOTE_HOST_LIMITS.directoryDepth) throw fail();
    const entry = expected.get(relativePath);
    if (relativePath && !entry) throw fail();
    const before = await lstat(path);
    if (before.isSymbolicLink() || resolve(await realpath(path)) !== resolve(path)) throw fail();
    if (entry) seen.add(relativePath);
    if (before.isDirectory()) {
      if (entry && entry.type !== "directory") throw fail();
      for await (const child of await opendir(path)) await walk(join(path, child.name), relativePath ? `${relativePath}/${child.name}` : child.name, depth + 1);
      const after = await lstat(path);
      if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) throw fail();
      return;
    }
    if (!entry || entry.type !== "file" || !before.isFile() || before.size !== entry.size) throw fail();
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw fail();
      const hash = createHash("sha256"); let bytes = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        signal.throwIfAborted(); bytes += (chunk as Buffer).length;
        if (bytes > entry.size) throw fail(); hash.update(chunk);
      }
      const after = await handle.stat(); const current = await lstat(path);
      if (bytes !== entry.size || hash.digest("hex") !== entry.sha256 || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) throw fail();
    } finally { await handle.close(); }
  };
  try {
    if (!(await lstat(folder)).isDirectory()) throw fail();
    await walk(folder, "", 0);
    if (seen.size !== expected.size) throw fail();
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof RemoteHostError) throw error;
    throw fail();
  }
}
