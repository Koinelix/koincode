import { createHash } from "node:crypto";
import { posix } from "node:path";
import { REMOTE_HOST_LIMITS, RemoteHostError, type RemoteFileStat, type RemoteManifestEntry, type RemoteSftpPort } from "@fcode/shared";
import { remoteInputDigest } from "./canonicalInput.js";

export interface RemotePathEvidence {
  stat: RemoteFileStat | null;
  digest: string;
  entries: Array<{ path: string; stat: RemoteFileStat; sha256?: string }>;
}

export async function inspectRemoteMetadata(files: RemoteSftpPort, path: string): Promise<RemotePathEvidence> {
  const stat = await files.stat(path);
  const entries = stat ? [{ path: ".", stat }] : [];
  return { stat, entries, digest: remoteInputDigest(entries) };
}

export async function remoteFileHash(files: RemoteSftpPort, path: string, size: number, signal?: AbortSignal): Promise<string> {
  if (!Number.isSafeInteger(size) || size < 0 || size > REMOTE_HOST_LIMITS.fileBytes) throw new RemoteHostError("transfer_limit", "The remote file exceeds the verification budget.", "verification");
  signal?.throwIfAborted();
  if (files.sha256) {
    const remote = await files.sha256(path, size, signal);
    if (remote !== null) {
      if (typeof remote !== "string" || !/^[a-f0-9]{64}$/.test(remote)) throw new RemoteHostError("hash_unverified", "The remote digest is invalid.", "verification");
      return remote;
    }
  }
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of files.read(path, size, signal)) { bytes += chunk.byteLength; hash.update(chunk); }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof RemoteHostError && (error.code === "execution_failed" || error.code === "capability_unavailable")) {
      throw new RemoteHostError("hash_unverified", "The server did not permit a complete SFTP content verification.", "verification");
    }
    throw error;
  }
  if (bytes !== size) throw new RemoteHostError("preflight_changed", "The remote file changed during verification.", "verification");
  return hash.digest("hex");
}

export async function inspectRemotePath(files: RemoteSftpPort, path: string, signal?: AbortSignal): Promise<RemotePathEvidence> {
  const entries: RemotePathEvidence["entries"] = [];
  let totalBytes = 0;
  const walk = async (current: string, relative: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (depth > REMOTE_HOST_LIMITS.directoryDepth || entries.length >= REMOTE_HOST_LIMITS.scannedEntries) {
      throw new RemoteHostError("transfer_limit", "The destination exceeds the preflight scan budget.");
    }
    const stat = await files.stat(current);
    if (!stat) throw new RemoteHostError("preflight_changed", "The destination changed during preflight.");
    if (stat.type === "symlink" || stat.type === "special") throw new RemoteHostError("path_not_allowed", "The destination contains a link or special file.");
    const entry: RemotePathEvidence["entries"][number] = { path: relative, stat };
    entries.push(entry);
    if (stat.type === "file") {
      totalBytes += stat.size;
      if (totalBytes > REMOTE_HOST_LIMITS.sourceBytes) throw new RemoteHostError("transfer_limit", "The destination exceeds the preflight byte budget.");
      entry.sha256 = await remoteFileHash(files, current, stat.size, signal);
    } else {
      let offset: number | undefined = 0;
      do {
        const page = await files.list(current, offset, REMOTE_HOST_LIMITS.maxPageSize, signal);
        for (const child of page.entries) {
          if (child.name.includes("/") || child.name === "." || child.name === "..") throw new RemoteHostError("path_not_allowed", "The server returned an invalid directory entry.");
          await walk(posix.join(current, child.name), relative === "." ? child.name : `${relative}/${child.name}`, depth + 1);
        }
        offset = page.nextOffset;
      } while (offset !== undefined);
    }
    const after = await files.stat(current);
    if (!after || remoteInputDigest(stat) !== remoteInputDigest(after)) throw new RemoteHostError("preflight_changed", "The destination changed during preflight.");
  };
  const stat = await files.stat(path);
  if (stat) await walk(path, ".", 0);
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { stat, entries, digest: remoteInputDigest(entries) };
}

export async function verifyRemoteManifest(files: RemoteSftpPort, path: string, entries: RemoteManifestEntry[],
  exact: boolean, signal?: AbortSignal): Promise<void> {
  const evidence = await inspectRemotePath(files, path, signal);
  const expected = entries.map((entry) => ({ ...entry, relativePath: entries.length === 1 && entry.type === "file" ? "." : entry.relativePath }));
  if (exact && evidence.entries.length !== expected.length) throw new RemoteHostError("verification_failed", "The uploaded directory entry count does not match.", "verification");
  for (const entry of expected) {
    const actual = evidence.entries.find((item) => item.path === entry.relativePath);
    if (!actual || actual.stat.type !== entry.type || (actual.stat.mode & 0o777) !== entry.mode ||
      entry.type === "file" && (actual.stat.size !== entry.size || actual.sha256 !== entry.sha256)) {
      throw new RemoteHostError("verification_failed", "The uploaded content or mode does not match the approved manifest.", "verification");
    }
  }
}
