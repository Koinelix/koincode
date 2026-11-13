import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { REMOTE_HOST_LIMITS, RemoteHostError } from "@fcode/shared";

const BYTES_PER_STAT_BLOCK = 512;

export function remoteSnapshotAllocation(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / REMOTE_HOST_LIMITS.snapshotAllocationBytes)) * REMOTE_HOST_LIMITS.snapshotAllocationBytes;
}

/** Include empty entries, allocated blocks and logical bytes; never traverse links. */
export async function remoteSnapshotUsage(root: string, signal?: AbortSignal): Promise<number> {
  let bytes = 0; let entries = 0;
  const walk = async (path: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (++entries > REMOTE_HOST_LIMITS.snapshotEntries || depth > REMOTE_HOST_LIMITS.directoryDepth + 1) {
      throw new RemoteHostError("snapshot_limit", "The private snapshot tree exceeds its accounting scan budget.", "storage");
    }
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) {
      throw new RemoteHostError("storage_corrupt", "A private snapshot contains a link or special file.", "storage");
    }
    bytes += Math.max(remoteSnapshotAllocation(stat.size), (stat.blocks ?? 0) * BYTES_PER_STAT_BLOCK);
    if (bytes > REMOTE_HOST_LIMITS.snapshotBytes) throw new RemoteHostError("snapshot_limit", "The private snapshot budget is full.", "storage");
    if (stat.isDirectory()) for await (const entry of await opendir(path)) await walk(join(path, entry.name), depth + 1);
  };
  await walk(root, 0);
  return bytes;
}
