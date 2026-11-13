import { RemoteHostError, REMOTE_HOST_LIMITS, remotePathSchema, type RemoteSshConnection } from "@fcode/shared";
import { quoteRemoteShellArgument } from "./shell.js";

export const REMOTE_HASH_UNAVAILABLE = "FCODE_SHA256_UNAVAILABLE\n";
const HASH_TIMEOUT_MS = 30_000;
const HASH_STDOUT_BYTES = 256;
const HASH_OUTPUT_BYTES = 4 * 1024;
const HASH_LINE = /^([a-fA-F0-9]{64}) [ *]-\n$/;

export function remoteHashCommand(path: string, expectedBytes: number): string {
  if (!remotePathSchema.safeParse(path).success || !path.startsWith("/")) {
    throw new RemoteHostError("path_not_allowed", "The hash target must be an authorized absolute path.", "verification");
  }
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > REMOTE_HOST_LIMITS.fileBytes) {
    throw new RemoteHostError("transfer_limit", "The hash target exceeds its verification budget.", "verification");
  }
  return [
    "LC_ALL=C; export LC_ALL",
    "fcode_head=; fcode_hash=",
    "for fcode_candidate in /usr/bin/head /bin/head; do if [ -x \"$fcode_candidate\" ]; then fcode_head=$fcode_candidate; break; fi; done",
    "for fcode_candidate in /usr/bin/sha256sum /bin/sha256sum /usr/bin/shasum /bin/shasum; do if [ -x \"$fcode_candidate\" ]; then fcode_hash=$fcode_candidate; break; fi; done",
    "if [ -z \"$fcode_head\" ] || [ -z \"$fcode_hash\" ]; then printf 'FCODE_SHA256_UNAVAILABLE\\n'; exit 127; fi",
    "case \"$fcode_hash\" in */shasum) set -- -a 256 ;; *) set -- ;; esac",
    `"$fcode_head" -c ${expectedBytes + 1} < ${quoteRemoteShellArgument(path)} | "$fcode_hash" "$@"`,
  ].join("\n");
}

/** Only the broker's guarded file verifier receives this fixed, read-only command path. */
export class RemoteHashProbe {
  private unavailable = false;
  constructor(private readonly execute: RemoteSshConnection["exec"], private readonly assertLive: () => void,
    private readonly timeoutMs = HASH_TIMEOUT_MS) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > HASH_TIMEOUT_MS) throw new Error("Invalid hash timeout budget.");
  }

  async sha256(path: string, expectedBytes: number, signal?: AbortSignal): Promise<string | null> {
    const command = remoteHashCommand(path, expectedBytes);
    signal?.throwIfAborted(); this.assertLive();
    if (this.unavailable) return null;
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let stdout = Buffer.alloc(0); let bytes = 0; let stderrBytes = 0;
    const invalid = () => new RemoteHostError("hash_unverified", "The remote hash command did not return one verified digest.", "verification");
    let result;
    try {
      result = await this.execute({ command }, { signal: combined, onOutput(stream, value) {
        bytes += value.byteLength;
        if (bytes > HASH_OUTPUT_BYTES) throw invalid();
        if (stream === "stderr") { stderrBytes += value.byteLength; return; }
        if (stdout.length + value.byteLength > HASH_STDOUT_BYTES) throw invalid();
        stdout = Buffer.concat([stdout, value]);
      } });
    } catch (error) {
      signal?.throwIfAborted();
      if (deadline.aborted) throw invalid();
      if (error instanceof RemoteHostError && error.code === "capability_unavailable") {
        this.assertLive(); this.unavailable = true; return null;
      }
      if (error instanceof RemoteHostError && error.code === "execution_unknown") { this.assertLive(); throw invalid(); }
      throw error;
    }
    signal?.throwIfAborted(); if (deadline.aborted) throw invalid(); this.assertLive();
    const text = stdout.toString("latin1");
    if (result.exitCode === 127 && !result.signal && !stderrBytes && text === REMOTE_HASH_UNAVAILABLE) {
      this.unavailable = true; return null;
    }
    const match = HASH_LINE.exec(text);
    if (result.exitCode !== 0 || result.signal || stderrBytes || !match) throw invalid();
    return match[1]!.toLowerCase();
  }
}
