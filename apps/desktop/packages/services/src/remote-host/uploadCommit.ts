import { posix } from "node:path";
import { createHash } from "node:crypto";
import { RemoteHostError, type RemoteExecutionRecord, type RemoteSftpPort, type RemoteManifestEntry } from "@fcode/shared";
import { inspectRemotePath, remoteFileHash, verifyRemoteManifest } from "./remoteFileEvidence.js";
import type { RemotePreparedTarget } from "./preparedTypes.js";

export type RemoteExecutionPatch = (patch: Partial<RemoteExecutionRecord>) => void;

export async function checkRemoteCondition(files: RemoteSftpPort, target: RemotePreparedTarget, signal?: AbortSignal): Promise<void> {
  const current = await inspectRemotePath(files, target.path!, signal);
  if (current.digest !== target.condition!.digest) throw new RemoteHostError(target.expectedHash !== undefined ? "file_conflict" : "preflight_changed", "The destination changed after approval.", "verification");
}

export async function publishRemoteUpload(input: {
  files: RemoteSftpPort; target: RemotePreparedTarget; staging: string; backup: string; receipt: string;
  execution: RemoteExecutionRecord; entries: RemoteManifestEntry[]; directory: boolean;
  patch: RemoteExecutionPatch; signal: AbortSignal;
}): Promise<void> {
  const { files, target, staging, backup, receipt, patch, signal } = input;
  signal.throwIfAborted();
  await checkRemoteCondition(files, target, signal);
  if (input.directory && target.ifExists === "replace" && target.condition!.stat) {
    if (await files.stat(backup)) throw new RemoteHostError("preflight_changed", "The backup path is already occupied.");
    patch({ uploadStage: "backup_intent", backupPath: backup });
    await files.rename(target.path!, backup, false);
    patch({ uploadStage: "backed_up" });
  }
  signal.throwIfAborted();
  patch({ uploadStage: "publish_intent" });
  if (input.directory && target.ifExists === "merge" && target.condition!.stat) {
    await mergeRemoteUpload(files, target, staging, input.entries, signal);
  } else await files.rename(staging, target.path!, !input.directory && target.ifExists === "overwrite");
  patch({ uploadStage: "published" });
  // A receipt is independent evidence; failure after publication must remain uncertain.
  const content = Buffer.from(JSON.stringify({ version: 1, executionId: input.execution.executionId,
    attempt: input.execution.attempt, manifestHash: input.execution.manifestHash, remotePath: target.path, published: true }));
  await files.write(receipt, (async function* () { yield content; })(), { signal });
  await verifyRemoteManifest(files, target.path!, input.entries, target.ifExists !== "merge", signal);
  const receiptInfo = await files.stat(receipt);
  if (!receiptInfo || receiptInfo.type !== "file" || await remoteFileHash(files, receipt, content.length, signal) !==
    createHash("sha256").update(content).digest("hex")) {
    throw new RemoteHostError("verification_failed", "The publication receipt could not be verified.", "verification");
  }
  patch({ uploadStage: "final_verified", verification: "verified" });
}

async function mergeRemoteUpload(files: RemoteSftpPort, target: RemotePreparedTarget, staging: string,
  entries: RemoteManifestEntry[], signal: AbortSignal): Promise<void> {
  const directories = entries.filter((entry) => entry.type === "directory").sort((a, b) => a.relativePath.length - b.relativePath.length);
  for (const entry of directories) {
    signal.throwIfAborted();
    const destination = posix.join(target.path!, entry.relativePath);
    const info = await files.stat(destination);
    if (!info) await files.mkdir(destination, 0o700);
    else if (info.type !== "directory") throw new RemoteHostError("preflight_changed", "A merge directory changed type.");
  }
  for (const entry of entries.filter((item) => item.type === "file")) {
    signal.throwIfAborted();
    const destination = posix.join(target.path!, entry.relativePath);
    const old = target.condition!.entries.find((item) => item.path === entry.relativePath);
    const current = await files.stat(destination);
    if (old) {
      if (!current || current.type !== "file" || current.size !== old.stat.size ||
        await remoteFileHash(files, destination, current.size, signal) !== old.sha256) {
        throw new RemoteHostError("preflight_changed", "A merge destination changed after approval.");
      }
    } else if (current) throw new RemoteHostError("preflight_changed", "A new file appeared in the merge destination.");
    await files.rename(posix.join(staging, entry.relativePath), destination, Boolean(old));
  }
  for (const entry of directories.reverse()) await files.chmod(posix.join(target.path!, entry.relativePath), entry.mode);
}
