import { posix } from "node:path";
import { RemoteHostError, type RemoteExecutionRecord, type RemoteSftpPort } from "@fcode/shared";
import { RemoteSnapshotStore } from "./snapshotStore.js";
import { RemotePathGuard } from "./remotePaths.js";
import { verifyRemoteManifest } from "./remoteFileEvidence.js";
import { publishRemoteUpload, type RemoteExecutionPatch } from "./uploadCommit.js";
import type { RemotePreparedCall, RemotePreparedTarget } from "./preparedTypes.js";

export class RemoteSnapshotUploader {
  constructor(private readonly sources: RemoteSnapshotStore) {}

  async run(prepared: RemotePreparedCall, target: RemotePreparedTarget, execution: RemoteExecutionRecord,
    files: RemoteSftpPort, patch: RemoteExecutionPatch, signal: AbortSignal): Promise<void> {
    const source = prepared.source!;
    const entries = prepared.entries!;
    const guard = await RemotePathGuard.create(target.host, files);
    const path = await guard.resolve(target.path!, { allowMissing: true, siblingRequired: true });
    const suffix = `${execution.executionId}-${execution.attempt}`;
    const staging = `${path}.fcode-upload-${suffix}`;
    const backup = `${path}.fcode-backup-${suffix}`;
    const receipt = `${path}.fcode-receipt-${suffix}.json`;
    for (const auxiliary of [staging, backup, receipt]) {
      await guard.resolve(auxiliary, { allowMissing: true });
      if (await files.stat(auxiliary)) throw new RemoteHostError("preflight_changed", "An upload auxiliary path is already occupied.");
    }
    patch({ stagingPath: staging, receiptPath: receipt, uploadStage: "staging", residualPaths: [staging, receipt] });
    let bytes = 0;
    let count = 0;
    let lastProgress = 0;
    if (source.kind === "directory") {
      await files.mkdir(staging, 0o700);
      for (const entry of entries.filter((item) => item.type === "directory" && item.relativePath !== ".")
        .sort((a, b) => a.relativePath.length - b.relativePath.length)) {
        signal.throwIfAborted(); await files.mkdir(posix.join(staging, entry.relativePath), 0o700);
      }
    }
    // Serial streaming stays within the per-host stream budget without buffering file contents.
    for (const entry of entries.filter((item) => item.type === "file")) {
      signal.throwIfAborted();
      const destination = source.kind === "file" ? staging : posix.join(staging, entry.relativePath);
      const written = await files.write(destination, this.sources.read(source, entry, signal), { signal, onProgress: (current) => {
        const now = Date.now();
        if (now - lastProgress >= 250) { lastProgress = now; patch({ uploadedBytes: bytes + current, uploadedFiles: count }); }
      } });
      if (written.bytes !== entry.size || written.sha256 !== entry.sha256) {
        throw new RemoteHostError("source_changed", "The frozen upload file no longer matches its approved hash.", "verification");
      }
      await files.chmod(destination, entry.mode);
      bytes += written.bytes; count++;
      patch({ uploadedBytes: bytes, uploadedFiles: count });
    }
    for (const entry of entries.filter((item) => item.type === "directory").sort((a, b) => b.relativePath.length - a.relativePath.length)) {
      await files.chmod(entry.relativePath === "." ? staging : posix.join(staging, entry.relativePath), entry.mode);
    }
    patch({ state: "verifying" });
    await verifyRemoteManifest(files, staging, entries, true, signal);
    patch({ uploadStage: "staged_verified" });
    await publishRemoteUpload({ files, target, staging, backup, receipt, execution, entries, directory: source.kind === "directory", patch, signal });
    const residual = [receipt];
    if (target.ifExists === "replace" && target.condition?.stat) residual.push(backup);
    // Empty staging directories from merge remain explicit rather than risking deletion of a raced path.
    if (source.kind === "directory" && target.ifExists === "merge" && target.condition?.stat) residual.push(staging);
    patch({ residualPaths: residual });
  }
}
