import { openSync, closeSync, writeSync } from "node:fs";
import { join } from "node:path";
import { REMOTE_HOST_LIMITS, RemoteHostError, remoteIdSchema } from "@fcode/shared";
import { createRemoteHostPrivateDirectory, protectRemoteHostPath } from "./privatePaths.js";
import { normalizeRemoteStorageError } from "./database.js";

interface OutputStreamState { decoder: TextDecoder; pending: string }

export class RemoteExecutionOutput {
  private readonly streams: Record<"stdout" | "stderr", OutputStreamState> = {
    stdout: { decoder: new TextDecoder(), pending: "" }, stderr: { decoder: new TextDecoder(), pending: "" },
  };
  private bytes = 0;
  private summary = "";
  private truncated = false;
  private closed = false;
  private constructor(private readonly descriptor: number, private readonly secrets: string[]) {}

  static async create(root: string, executionId: string, attempt: number, secrets: string[]): Promise<RemoteExecutionOutput> {
    const path = remoteExecutionOutputPath(root, executionId, attempt);
    await createRemoteHostPrivateDirectory(root);
    const descriptor = openSync(path, "wx", 0o600);
    try { await protectRemoteHostPath(path, false); }
    catch (error) { closeSync(descriptor); throw normalizeRemoteStorageError(error); }
    return new RemoteExecutionOutput(descriptor, [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length));
  }

  append = (stream: "stdout" | "stderr", chunk: Uint8Array): void => {
    if (this.closed) throw new RemoteHostError("storage_corrupt", "The execution output is already closed.", "storage");
    const state = this.streams[stream];
    state.pending += state.decoder.decode(chunk, { stream: true });
    const carry = Math.max(1, ...this.secrets.map((secret) => secret.length)) - 1;
    this.flush(stream, Math.max(0, state.pending.length - carry));
  };

  finish(): { outputBytes: number; outputTruncated: boolean; summary: string } {
    if (!this.closed) {
      try {
        for (const stream of ["stdout", "stderr"] as const) {
          this.streams[stream].pending += this.streams[stream].decoder.decode();
          this.flush(stream, this.streams[stream].pending.length);
        }
      } finally { this.closed = true; closeSync(this.descriptor); this.secrets.length = 0; }
    }
    return { outputBytes: this.bytes, outputTruncated: this.truncated, summary: this.summary };
  }

  private flush(stream: "stdout" | "stderr", length: number): void {
    const state = this.streams[stream];
    // Mask in place to preserve offsets across chunk boundaries and overlapping secret values.
    let masked = state.pending;
    for (const secret of this.secrets) masked = masked.replaceAll(secret, "*".repeat(secret.length));
    if (length > 0 && length < masked.length && /[\uD800-\uDBFF]/.test(masked[length - 1]!) && /[\uDC00-\uDFFF]/.test(masked[length]!)) length--;
    const content = masked.slice(0, length);
    state.pending = masked.slice(length);
    if (!content) return;
    const encoded = Buffer.from(JSON.stringify({ stream, text: content }) + "\n");
    if (this.bytes + encoded.length <= REMOTE_HOST_LIMITS.outputBytes) {
      try {
        let offset = 0;
        while (offset < encoded.length) {
          const written = writeSync(this.descriptor, encoded, offset);
          if (written <= 0) throw new Error("Execution output write made no progress");
          offset += written;
        }
      }
      catch (error) { throw normalizeRemoteStorageError(error); }
      this.bytes += encoded.length;
    } else this.truncated = true;
    const summaryBudget = REMOTE_HOST_LIMITS.modelBytes - 4096;
    const remaining = summaryBudget - Buffer.byteLength(JSON.stringify({ summary: this.summary }));
    let addition = remaining > 0 ? Buffer.from(content).subarray(0, remaining).toString("utf8") : "";
    while (addition && Buffer.byteLength(JSON.stringify({ summary: this.summary + addition })) > summaryBudget) addition = addition.slice(0, Math.floor(addition.length / 2));
    this.summary += addition;
    if (addition !== content) this.truncated = true;
  }
}

export function remoteExecutionOutputPath(root: string, executionId: string, attempt: number): string {
  remoteIdSchema.parse(executionId);
  if (!/^[a-f0-9-]{36}$/i.test(executionId) || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RemoteHostError("invalid_request", "Invalid execution output identifier.");
  }
  return join(root, `${executionId}-${attempt}.jsonl`);
}
