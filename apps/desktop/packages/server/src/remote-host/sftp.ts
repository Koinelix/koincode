import type { SFTPWrapper, Attributes, FileEntryWithStats, FileEntry } from "ssh2";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { REMOTE_HOST_LIMITS, RemoteHostError, type RemoteFileStat,
  type RemoteDirectoryEntry, type RemoteSftpPort } from "@fcode/shared";

const SFTP_EOF = 1;
const SFTP_NO_SUCH_FILE = 2;
const SFTP_NO_CONNECTION = 6;
const SFTP_CONNECTION_LOST = 7;
const SFTP_UNSUPPORTED = 8;
const TEMPORARY_FILE_MODE = 0o600;
const TRANSFER_CHUNK_BYTES = 64 * 1024;

function unsupported(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? Number(error.code) : 0;
  return code === SFTP_UNSUPPORTED || error instanceof Error && error.message === "Server does not support this extended request";
}
function sftpError(error: unknown): RemoteHostError {
  if (unsupported(error)) return new RemoteHostError("capability_unavailable", "The server does not support the required SFTP operation.", "execution");
  const code = typeof error === "object" && error !== null && "code" in error ? Number(error.code) : 0;
  if (code === SFTP_NO_CONNECTION || code === SFTP_CONNECTION_LOST || error instanceof Error && error.message === "No response from server") {
    return new RemoteHostError("connection_failed", "The SFTP connection closed before its response was confirmed.", "connection");
  }
  return new RemoteHostError("execution_failed", "The SFTP operation failed. Inspect the target permissions and available space.", "execution");
}

function attributes(value: Attributes): RemoteFileStat {
  const kind = value.mode & constants.S_IFMT;
  return { size: value.size, mode: value.mode, mtime: value.mtime,
    type: kind === constants.S_IFREG ? "file" : kind === constants.S_IFDIR ? "directory" : kind === constants.S_IFLNK ? "symlink" : "special" };
}

export class RemoteSftpAdapter implements RemoteSftpPort {
  private failure?: RemoteHostError;
  private readonly pending = new Set<(error: RemoteHostError) => void>();
  private closeTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private readonly sftp: SFTPWrapper,
    private readonly hash?: (path: string, expectedBytes: number, signal?: AbortSignal) => Promise<string | null>,
    private readonly onStalledClose?: () => void, private readonly closeWaitMs = REMOTE_HOST_LIMITS.cancelWaitMs + 100) {
    // Protocol errors remain observable through request failures instead of escaping as unhandled EventEmitter errors.
    sftp.on("error", (error: unknown) => this.failPending(sftpError(error)));
    sftp.on("close", () => {
      this.closed = true; clearTimeout(this.closeTimer);
      this.failPending(new RemoteHostError("connection_failed", "The SFTP channel is closed.", "connection"));
    });
  }
  private assertLive(): void { if (this.failure) throw this.failure; }
  close(): void {
    this.failPending(new RemoteHostError("canceled", "The SFTP channel was released.", "connection"));
    if (this.closed || this.closeTimer) return;
    if (this.onStalledClose) {
      this.closeTimer = setTimeout(() => { if (!this.closed) this.onStalledClose?.(); }, this.closeWaitMs);
      this.closeTimer.unref();
    }
    this.sftp.destroy();
  }
  private failPending(error: RemoteHostError): void {
    this.failure ??= error;
    for (const reject of this.pending) reject(this.failure);
  }
  private request<T>(run: (resolve: (value: T) => void, reject: (error: unknown) => void) => void): Promise<T> {
    this.assertLive();
    return new Promise<T>((resolve, reject) => {
      const fail = (error: unknown) => { this.pending.delete(fail); reject(error); };
      this.pending.add(fail);
      try { run((value) => { this.pending.delete(fail); resolve(value); }, fail); }
      catch (error) { fail(error); }
    });
  }
  private openHandle(path: string, flags: "r" | "wx"): Promise<Buffer> {
    this.assertLive();
    return this.request((resolve, reject) => this.sftp.open(path, flags, { mode: TEMPORARY_FILE_MODE }, (error, handle) =>
      error ? reject(sftpError(error)) : resolve(handle)));
  }
  private closeHandle(handle: Buffer): Promise<void> {
    this.assertLive();
    return this.request((resolve, reject) => this.sftp.close(handle, (error) => error ? reject(sftpError(error)) : resolve()));
  }

  realpath(path: string): Promise<string> {
    this.assertLive();
    return this.request((resolve, reject) => this.sftp.realpath(path, (error, actual) => error ? reject(sftpError(error)) : resolve(actual)));
  }

  stat(path: string): Promise<RemoteFileStat | null> {
    this.assertLive();
    return this.request((resolve, reject) => this.sftp.lstat(path, (error, value) => {
      if (error && "code" in error && Number(error.code) === SFTP_NO_SUCH_FILE) return resolve(null);
      if (error) return reject(sftpError(error));
      resolve(attributes(value));
    }));
  }

  async list(path: string, offset: number, limit: number, signal?: AbortSignal): Promise<{ entries: RemoteDirectoryEntry[]; nextOffset?: number }> {
    if (!Number.isSafeInteger(offset) || offset < 0 || limit < 1 || limit > REMOTE_HOST_LIMITS.maxPageSize) {
      throw new RemoteHostError("invalid_request", "Invalid directory page.");
    }
    signal?.throwIfAborted(); this.assertLive();
    const handle = await this.request<Buffer>((resolve, reject) => this.sftp.opendir(path, (error, value) => error ? reject(sftpError(error)) : resolve(value)));
    const result: RemoteDirectoryEntry[] = [];
    let index = 0;
    let more = false;
    let closeFailure: unknown;
    try {
      while (result.length <= limit) {
        signal?.throwIfAborted();
        const values = await this.request<FileEntryWithStats[] | false>((resolve, reject) =>
          this.sftp.readdir(handle, (error, entries) => {
            if (error && "code" in error && Number(error.code) === SFTP_EOF) return resolve(false);
            if (error) reject(sftpError(error)); else resolve(entries);
          }));
        if (!values) break;
        for (const entry of values as FileEntry[]) {
          if (entry.filename === "." || entry.filename === "..") continue;
          if (index++ < offset) continue;
          if (result.length === limit) { more = true; break; }
          result.push({ name: entry.filename, ...attributes(entry.attrs) });
        }
        if (more) break;
      }
    } finally {
      try { await this.closeHandle(handle); } catch (error) { closeFailure = error; }
    }
    if (closeFailure) throw closeFailure;
    return { entries: result, ...(more ? { nextOffset: offset + result.length } : {}) };
  }

  mkdir(path: string, mode: number): Promise<void> {
    this.assertLive();
    return this.request((resolve, reject) => this.sftp.mkdir(path, { mode }, (error) => error ? reject(sftpError(error)) : resolve()));
  }
  chmod(path: string, mode: number): Promise<void> {
    this.assertLive();
    return this.request((resolve, reject) => this.sftp.chmod(path, mode, (error) => error ? reject(sftpError(error)) : resolve()));
  }
  rename(from: string, to: string, overwrite: boolean): Promise<void> {
    this.assertLive();
    return this.request((resolve, reject) => {
      const finish = (error: Error | undefined | null) => error ? reject(sftpError(error)) : resolve();
      try {
        if (overwrite) this.sftp.ext_openssh_rename(from, to, finish); else this.sftp.rename(from, to, finish);
      } catch (error) { reject(sftpError(error)); }
    });
  }
  unlink(path: string): Promise<void> {
    this.assertLive();
    return this.request((resolve, reject) => this.sftp.unlink(path, (error) => error ? reject(sftpError(error)) : resolve()));
  }
  rmdir(path: string): Promise<void> {
    this.assertLive();
    return this.request((resolve, reject) => this.sftp.rmdir(path, (error) => error ? reject(sftpError(error)) : resolve()));
  }
  availableBytes(path: string): Promise<number | null> {
    this.assertLive();
    return this.request((resolve, reject) => {
      try {
        this.sftp.ext_openssh_statvfs(path, (error, info) => {
          const available = !error && info ? Number(info.bavail) * Number(info.frsize) : NaN;
          resolve(Number.isFinite(available) && available >= 0 ? Math.min(available, Number.MAX_SAFE_INTEGER) : null);
        });
      } catch (error) { if (unsupported(error)) resolve(null); else reject(sftpError(error)); }
    });
  }

  sha256(path: string, expectedBytes: number, signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted(); this.assertLive();
    return this.hash ? this.hash(path, expectedBytes, signal) : Promise.resolve(null);
  }

  async *read(path: string, maxBytes: number, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    signal?.throwIfAborted();
    const handle = await this.openHandle(path, "r"); let position = 0; let closeFailure: unknown;
    try {
      while (true) {
        signal?.throwIfAborted(); this.assertLive();
        const buffer = Buffer.alloc(Math.min(TRANSFER_CHUNK_BYTES, Math.max(1, maxBytes - position + 1)));
        const bytes = await this.request<number>((resolve, reject) => this.sftp.read(handle, buffer, 0, buffer.length, position,
          (error, count) => error ? reject(sftpError(error)) : resolve(count)));
        if (!bytes) break;
        position += bytes;
        if (position > maxBytes) throw new RemoteHostError("output_limit", "The remote file exceeds the authorized read budget.", "execution");
        yield buffer.subarray(0, bytes);
      }
    } finally {
      // ssh2 streams can finish before their CLOSE callback. Explicit handles prevent late errors after connection release.
      try { await this.closeHandle(handle); } catch (error) { closeFailure = error; }
    }
    if (closeFailure) throw closeFailure;
  }

  async write(path: string, content: AsyncIterable<Uint8Array>, options: {
    signal?: AbortSignal; onProgress?: (bytes: number) => void;
  }): Promise<{ bytes: number; sha256: string }> {
    options.signal?.throwIfAborted();
    const handle = await this.openHandle(path, "wx"); const digest = createHash("sha256");
    let bytes = 0; let closeFailure: unknown;
    try {
      for await (const value of content) {
        const chunk = Buffer.from(value);
        for (let offset = 0; offset < chunk.length; offset += TRANSFER_CHUNK_BYTES) {
          options.signal?.throwIfAborted(); this.assertLive();
          const part = chunk.subarray(offset, offset + TRANSFER_CHUNK_BYTES);
          if (bytes + part.length > REMOTE_HOST_LIMITS.fileBytes) throw new RemoteHostError("transfer_limit", "The upload file exceeds its transfer limit.");
          await this.request<void>((resolve, reject) => this.sftp.write(handle, part, 0, part.length, bytes,
            (error) => error ? reject(sftpError(error)) : resolve()));
          bytes += part.length; digest.update(part); options.onProgress?.(bytes);
        }
      }
    } finally {
      try { await this.closeHandle(handle); } catch (error) { closeFailure = error; }
    }
    if (closeFailure) throw closeFailure;
    return { bytes, sha256: digest.digest("hex") };
  }
}
