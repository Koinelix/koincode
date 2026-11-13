import { createHash } from "node:crypto";
import { RemoteHostError, type RemoteExecutionRecord, type RemoteSftpPort } from "@fcode/shared";
import { RemotePathGuard } from "./remotePaths.js";
import { verifyRemoteManifest } from "./remoteFileEvidence.js";
import { checkRemoteCondition, type RemoteExecutionPatch } from "./uploadCommit.js";
import type { RemotePreparedCall, RemotePreparedTarget } from "./preparedTypes.js";

export async function writeRemoteText(prepared: RemotePreparedCall, target: RemotePreparedTarget,
  execution: RemoteExecutionRecord, files: RemoteSftpPort, patch: RemoteExecutionPatch, signal: AbortSignal): Promise<void> {
  const guard = await RemotePathGuard.create(target.host, files);
  const destination = await guard.resolve(target.path!, { allowMissing: true, siblingRequired: true });
  const temporary = `${destination}.fcode-write-${execution.executionId}-${execution.attempt}`;
  await guard.resolve(temporary, { allowMissing: true });
  if (await files.stat(temporary)) throw new RemoteHostError("preflight_changed", "The temporary write path is already occupied.");
  const content = Buffer.from(String(prepared.input.content), "utf8");
  const hash = createHash("sha256").update(content).digest("hex");
  const manifest = [{ type: "file" as const, relativePath: "content", size: content.length,
    mode: target.condition?.stat ? target.condition.stat.mode & 0o777 : 0o644, sha256: hash }];
  patch({ stagingPath: temporary, residualPaths: [temporary], uploadStage: "staging" });
  const result = await files.write(temporary, (async function* () { yield content; })(), { signal });
  if (result.sha256 !== hash || result.bytes !== content.length) throw new RemoteHostError("verification_failed", "The temporary text write hash did not match.", "verification");
  await files.chmod(temporary, manifest[0]!.mode);
  patch({ state: "verifying" });
  await verifyRemoteManifest(files, temporary, manifest, true, signal);
  patch({ uploadStage: "staged_verified" });
  await checkRemoteCondition(files, target, signal);
  signal.throwIfAborted();
  patch({ uploadStage: "publish_intent" });
  await files.rename(temporary, destination, target.ifExists === "overwrite");
  patch({ uploadStage: "published" });
  await verifyRemoteManifest(files, destination, manifest, true, signal);
  patch({ uploadStage: "final_verified", verification: "verified", residualPaths: [] });
}
