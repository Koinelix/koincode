import { mkdir, lstat, opendir, realpath, rm, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  REMOTE_HOST_LIMITS, RemoteHostError, remoteSourceRecordSchema, type RemoteSourceRecord,
  type RemoteManifestEntry, type RemoteSelection,
} from "@fcode/shared";
import { RemoteHostDatabase } from "./database.js";
import { createRemoteHostPrivateDirectory } from "./privatePaths.js";
import { freezeRemoteFile, pathInside } from "./snapshotFiles.js";
import { isSensitiveUploadPath, remoteManifestHash, uploadMode, validateUploadEntryName } from "./snapshotManifest.js";
import { remoteSnapshotUsage, remoteSnapshotAllocation } from "./snapshotUsage.js";
import { verifyRemoteSnapshot } from "./snapshotConfirmation.js";
import { remoteInputDigest } from "./canonicalInput.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE_DIRECTORY_MODE = 0o700;

export interface FreezeRemoteSourceInput {
  origin: RemoteSourceRecord["origin"];
  path: string;
  ownerId: string;
  workspaceKey: string;
  binding: RemoteSelection["binding"];
  workspaceRoot?: string;
  callId?: string;
  confirmedSensitivePaths?: string[];
  signal?: AbortSignal;
}

export class RemoteSnapshotStore {
  private readonly references = new Map<string, number>();
  private readonly readySources = new Set<string>();
  private queue = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  constructor(private readonly database: RemoteHostDatabase, private root: string) {}

  private folder(snapshotId: string): string {
    if (!UUID_PATTERN.test(snapshotId)) throw new RemoteHostError("storage_corrupt", "The stored snapshot identifier is invalid.", "storage");
    return join(this.root, snapshotId);
  }

  private records(): RemoteSourceRecord[] {
    return this.database.connection.prepare("SELECT document FROM remote_upload_sources").all()
      .map((row) => this.decode(row.document));
  }

  private decode(document: unknown): RemoteSourceRecord {
    try {
      if (typeof document !== "string") throw new Error("Missing source");
      const result = remoteSourceRecordSchema.parse(JSON.parse(document));
      if (!UUID_PATTERN.test(result.sourceId) || !UUID_PATTERN.test(result.snapshotId) || !Array.isArray(result.entries) ||
        result.entries.some((entry) => !validateUploadEntryName(entry.relativePath))) throw new Error("Invalid source");
      if (remoteManifestHash(result.entries) !== result.manifestHash) throw new Error("Invalid manifest");
      return result;
    } catch { throw new RemoteHostError("storage_corrupt", "An upload source record is invalid.", "storage"); }
  }

  get(sourceId: string): RemoteSourceRecord {
    const row = this.database.connection.prepare("SELECT document FROM remote_upload_sources WHERE source_id = ?").get(sourceId);
    if (!row) throw new RemoteHostError("source_not_found", "The upload source is unavailable. Select it again.");
    const source = this.decode(row.document);
    const expired = Date.now() - source.frozenAt > REMOTE_HOST_LIMITS.sourceTtlMs && !this.references.has(sourceId) && !this.protectedByExecution(sourceId);
    return { ...source, availability: source.availability === "expired" || expired ? "expired" : this.readySources.has(sourceId) ? "ready" : "requires_confirmation" };
  }

  listOwned(input: { ownerId: string; workspaceKey: string; binding: RemoteSelection["binding"]; cursor?: string; limit: number }) {
    const items = this.records().filter((source) => source.ownerId === input.ownerId && source.workspaceKey === input.workspaceKey &&
      !source.callId && source.origin !== "workspace_path" && remoteInputDigest(source.binding) === remoteInputDigest(input.binding) &&
      (!input.cursor || source.sourceId > input.cursor)).sort((left, right) => left.sourceId.localeCompare(right.sourceId))
      .map((source) => this.get(source.sourceId)).filter((source) => source.availability !== "expired");
    const page = items.slice(0, input.limit);
    return { items: page, ...(items.length > page.length ? { nextCursor: page.at(-1)!.sourceId } : {}) };
  }

  assertOwned(sourceId: string, input: { ownerId: string; workspaceKey: string; binding: RemoteSelection["binding"] }): RemoteSourceRecord {
    const source = this.get(sourceId);
    if (source.ownerId !== input.ownerId || source.workspaceKey !== input.workspaceKey || source.callId || source.origin === "workspace_path" ||
      remoteInputDigest(source.binding) !== remoteInputDigest(input.binding)) throw new RemoteHostError("permission_denied", "The upload source belongs to another draft or session.", "authorization");
    return source;
  }

  confirm(input: { sourceId: string; ownerId: string; workspaceKey: string; binding: RemoteSelection["binding"];
    expectedManifestHash: string; expectedFrozenAt: number; signal?: AbortSignal }): Promise<RemoteSourceRecord> {
    const signal = AbortSignal.any([AbortSignal.timeout(REMOTE_HOST_LIMITS.uploadMs), ...(input.signal ? [input.signal] : [])]);
    const result = this.queue.then(async () => {
      this.assertOpen();
      signal.throwIfAborted();
      const source = this.assertOwned(input.sourceId, input);
      if (source.availability === "expired" || Date.now() - source.frozenAt > REMOTE_HOST_LIMITS.sourceTtlMs) {
        throw new RemoteHostError("source_not_found", "The frozen upload source expired. Select it again.");
      }
      if (source.manifestHash !== input.expectedManifestHash || source.frozenAt !== input.expectedFrozenAt) {
        throw new RemoteHostError("source_changed", "The upload source preview changed. Review the current frozen version.");
      }
      this.root = await realpath(this.root);
      await verifyRemoteSnapshot(this.folder(source.snapshotId), source, signal);
      signal.throwIfAborted();
      const current = this.assertOwned(input.sourceId, input);
      if (current.availability === "expired" || Date.now() - current.frozenAt > REMOTE_HOST_LIMITS.sourceTtlMs ||
        remoteInputDigest({ ...current, availability: undefined }) !== remoteInputDigest({ ...source, availability: undefined })) {
        throw new RemoteHostError("source_changed", "The frozen source changed while it was being confirmed.");
      }
      this.readySources.add(source.sourceId);
      this.startMaintenance();
      return this.get(source.sourceId);
    });
    this.queue = result.then(() => {}, () => {}); return result;
  }

  /** Called within the trusted human message binding transaction, never by Renderer or model input. */
  promote(sourceId: string, input: { ownerId: string; workspaceKey: string; binding: RemoteSelection["binding"]; sessionId: string }): void {
    const source = this.assertOwned(sourceId, input);
    if (source.availability !== "ready") throw new RemoteHostError("source_not_found", "Confirm the upload source before binding its message.");
    if (input.binding.kind === "session" && input.binding.sessionId !== input.sessionId) {
      throw new RemoteHostError("permission_denied", "The upload source cannot move to another session.", "authorization");
    }
    this.database.connection.prepare("UPDATE remote_upload_sources SET document = ? WHERE source_id = ?")
      .run(JSON.stringify({ ...source, binding: { kind: "session", sessionId: input.sessionId } }), sourceId);
  }

  contentPath(record: RemoteSourceRecord, entry: RemoteManifestEntry): string {
    if (!validateUploadEntryName(entry.relativePath)) throw new RemoteHostError("source_changed", "The snapshot path is invalid.");
    return join(this.folder(record.snapshotId), ...entry.relativePath.split("/"));
  }

  async *read(record: RemoteSourceRecord, entry: RemoteManifestEntry, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    await this.validate(record.sourceId, true);
    const path = this.contentPath(record, entry);
    if (resolve(await realpath(path)) !== resolve(path)) throw new RemoteHostError("source_changed", "The private snapshot resolved through a link.");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== entry.size) throw new RemoteHostError("source_changed", "The frozen upload file changed.");
      let count = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        signal?.throwIfAborted(); count += (chunk as Buffer).length;
        if (count > entry.size) throw new RemoteHostError("source_changed", "The frozen upload file grew.");
        yield chunk as Uint8Array;
      }
      if (count !== entry.size) throw new RemoteHostError("source_changed", "The frozen upload file was truncated.");
    } finally { await handle.close(); }
  }

  retain(sourceId: string): () => void {
    this.get(sourceId);
    this.references.set(sourceId, (this.references.get(sourceId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.references.get(sourceId) ?? 1) - 1;
      if (remaining) this.references.set(sourceId, remaining); else this.references.delete(sourceId);
    };
  }

  freeze(input: FreezeRemoteSourceInput): Promise<RemoteSourceRecord> {
    const signal = AbortSignal.any([AbortSignal.timeout(REMOTE_HOST_LIMITS.uploadMs), ...(input.signal ? [input.signal] : [])]);
    const result = this.queue.then(() => { this.assertOpen(); return this.freezeSerialized({ ...input, signal }); });
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  private async freezeSerialized(input: FreezeRemoteSourceInput): Promise<RemoteSourceRecord> {
    input.signal?.throwIfAborted();
    const originalInfo = await lstat(input.path);
    if (originalInfo.isSymbolicLink() || !originalInfo.isFile() && !originalInfo.isDirectory()) {
      throw new RemoteHostError("path_not_allowed", "Select a regular file or directory, not a link or special file.");
    }
    const originalPath = await realpath(input.path);
    if (input.origin === "workspace_path") {
      if (!input.workspaceRoot || !input.callId || !pathInside(await realpath(input.workspaceRoot), originalPath)) {
        throw new RemoteHostError("path_not_allowed", "The upload source must be inside the authorized workspace.");
      }
      if (isSensitiveUploadPath(originalPath)) throw new RemoteHostError("source_sensitive", "Select sensitive files explicitly using the file picker.");
    }
    await createRemoteHostPrivateDirectory(this.root);
    this.root = await realpath(this.root);
    await this.sweepSerialized(input.signal);
    const usedBytes = await remoteSnapshotUsage(this.root, input.signal) + this.records().reduce(
      (total, record) => total + remoteSnapshotAllocation(Buffer.byteLength(JSON.stringify(record))), 0);
    const available = REMOTE_HOST_LIMITS.snapshotBytes - usedBytes;
    if (available <= 0) throw new RemoteHostError("snapshot_limit", "The private upload snapshot budget is full.", "storage");
    const sourceId = randomUUID();
    const snapshotId = randomUUID();
    const folder = this.folder(snapshotId);
    await mkdir(folder, { mode: PRIVATE_DIRECTORY_MODE });
    const entries: RemoteManifestEntry[] = [];
    const skipped: RemoteSourceRecord["skipped"] = [];
    const confirmed = new Set(input.confirmedSensitivePaths ?? []);
    let bytes = 0;
    let files = 0;
    let visited = 0;
    let reserved = REMOTE_HOST_LIMITS.snapshotAllocationBytes;
    const walk = async (source: string, relativePath: string, depth: number): Promise<void> => {
      input.signal?.throwIfAborted();
      visited++;
      reserved += REMOTE_HOST_LIMITS.snapshotAllocationBytes + Buffer.byteLength(relativePath) * 2;
      if (reserved >= available) throw new RemoteHostError("snapshot_limit", "The private snapshot entry budget is full.", "storage");
      if (visited > REMOTE_HOST_LIMITS.scannedEntries || depth > REMOTE_HOST_LIMITS.directoryDepth) {
        throw new RemoteHostError("transfer_limit", "The upload directory exceeds the scan or depth limit.");
      }
      if (relativePath && !validateUploadEntryName(relativePath)) { skipped.push({ relativePath, reason: "invalid_name" }); return; }
      const info = await lstat(source);
      if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) {
        skipped.push({ relativePath, reason: info.isSymbolicLink() ? "symlink" : "special_file" }); return;
      }
      if (depth > 0 && isSensitiveUploadPath(source) && !confirmed.has(relativePath)) {
        skipped.push({ relativePath, reason: "sensitive" }); return;
      }
      if (!pathInside(originalInfo.isDirectory() ? originalPath : dirname(originalPath), await realpath(source))) {
        throw new RemoteHostError("source_changed", "The source directory changed during scanning.");
      }
      const destination = relativePath ? join(folder, ...relativePath.split("/")) : folder;
      if (info.isDirectory()) {
        await mkdir(destination, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
        entries.push({ type: "directory", relativePath: relativePath || ".", size: 0, mode: uploadMode(info.mode, true) });
        const directory = await opendir(source);
        for await (const entry of directory) await walk(join(source, entry.name), relativePath ? `${relativePath}/${entry.name}` : entry.name, depth + 1);
        const after = await lstat(source);
        if (!after.isDirectory() || after.dev !== info.dev || after.ino !== info.ino || after.mtimeMs !== info.mtimeMs) {
          throw new RemoteHostError("source_changed", "The source directory changed while it was being frozen.");
        }
      } else {
        if (++files > REMOTE_HOST_LIMITS.fileCount) throw new RemoteHostError("transfer_limit", "The upload source contains too many files.");
        if (reserved + remoteSnapshotAllocation(info.size) >= available) throw new RemoteHostError("snapshot_limit", "The private snapshot allocation budget is full.", "storage");
        const result = await freezeRemoteFile({ original: source, destination,
          sourceRoot: originalInfo.isDirectory() ? originalPath : dirname(originalPath),
          maxBytes: Math.min(REMOTE_HOST_LIMITS.sourceBytes - bytes, available - reserved), signal: input.signal });
        bytes += result.size;
        reserved += remoteSnapshotAllocation(result.size);
        if (reserved >= available) throw new RemoteHostError("snapshot_limit", "The private snapshot allocation budget is full.", "storage");
        entries.push({ type: "file", relativePath, size: result.size, mode: uploadMode(result.mode, false), sha256: result.sha256 });
      }
    };
    try {
      const displayName = basename(originalPath);
      await walk(originalPath, originalInfo.isDirectory() ? "" : displayName, 0);
      const record: RemoteSourceRecord = {
        sourceId, snapshotId, origin: input.origin, kind: originalInfo.isDirectory() ? "directory" : "file",
        ownerId: input.ownerId, workspaceKey: input.workspaceKey, binding: input.binding,
        originalPath, displayName, fileCount: files, directoryCount: entries.filter((entry) => entry.type === "directory").length,
        totalBytes: bytes, skippedCount: skipped.length, entries, skipped,
        manifestHash: remoteManifestHash(entries), frozenAt: Date.now(), availability: "ready",
        ...(input.callId ? { callId: input.callId } : {}),
      };
      if (await remoteSnapshotUsage(folder, input.signal) + remoteSnapshotAllocation(Buffer.byteLength(JSON.stringify(record))) > available) {
        throw new RemoteHostError("snapshot_limit", "The frozen snapshot exceeds the remaining private storage budget.", "storage");
      }
      input.signal?.throwIfAborted();
      this.database.connection.prepare("INSERT INTO remote_upload_sources(source_id, document) VALUES (?, ?)").run(sourceId, JSON.stringify(record));
      this.readySources.add(sourceId);
      this.startMaintenance();
      return record;
    } catch (error) {
      try { await rm(folder, { recursive: true, force: true }); }
      catch { throw new RemoteHostError("storage_corrupt", "The incomplete snapshot could not be removed. Private storage cleanup requires attention.", "storage"); }
      input.signal?.throwIfAborted();
      throw error;
    }
  }

  async expire(sourceId: string): Promise<void> {
    const source = this.get(sourceId);
    this.database.connection.prepare("UPDATE remote_upload_sources SET document = ? WHERE source_id = ?")
      .run(JSON.stringify({ ...source, availability: "expired" }), sourceId);
    this.readySources.delete(sourceId);
    if (this.references.has(sourceId) || this.protectedByExecution(sourceId)) return;
    await rm(this.folder(source.snapshotId), { recursive: true, force: true });
    this.database.connection.prepare("DELETE FROM remote_upload_sources WHERE source_id = ?").run(sourceId);
    this.readySources.delete(sourceId);
    this.syncMaintenance();
  }

  async validate(sourceId: string, retained = false): Promise<RemoteSourceRecord> {
    const source = this.get(sourceId);
    const held = retained && this.references.has(sourceId);
    if (source.availability !== "ready" && !held) throw new RemoteHostError("source_not_found", "Confirm this source again after restarting the application.");
    if (Date.now() - source.frozenAt > REMOTE_HOST_LIMITS.sourceTtlMs && !this.references.has(sourceId)) {
      throw new RemoteHostError("source_not_found", "The upload source expired. Select it again.");
    }
    this.root = await realpath(this.root);
    const folder = this.folder(source.snapshotId);
    if (!(await lstat(folder)).isDirectory() || resolve(await realpath(folder)) !== resolve(folder)) {
      throw new RemoteHostError("source_changed", "The private snapshot was replaced.");
    }
    return source;
  }

  async initialize(): Promise<void> {
    this.assertOpen();
    if (!this.hasStoredSources()) {
      try { await lstat(this.root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.stopMaintenance(); return; } throw error; }
    }
    await this.sweep();
  }

  sweep(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const result = this.queue.then(() => this.disposed ? undefined : this.sweepSerialized());
    this.queue = result.then(() => {}, () => {}); return result;
  }

  async dispose(): Promise<void> { this.disposed = true; this.stopMaintenance(); await this.queue; }

  private assertOpen(): void {
    if (this.disposed) throw new RemoteHostError("canceled", "The upload snapshot store is closed.");
  }

  private hasStoredSources(): boolean {
    return Boolean(this.database.connection.prepare("SELECT 1 FROM remote_upload_sources LIMIT 1").get());
  }

  private stopMaintenance(): void {
    if (!this.timer) return;
    clearInterval(this.timer); this.timer = undefined;
  }

  private syncMaintenance(): void {
    if (this.disposed || !this.hasStoredSources()) { this.stopMaintenance(); return; }
    this.startMaintenance();
  }

  private startMaintenance(): void {
    if (this.disposed) return;
    this.timer ??= setInterval(() => { void this.sweep().catch(() => { /* Admission reports storage failures before accepting a new source. */ }); }, REMOTE_HOST_LIMITS.snapshotSweepMs);
    this.timer.unref();
  }

  private async sweepSerialized(signal?: AbortSignal): Promise<void> {
    await createRemoteHostPrivateDirectory(this.root); this.root = await realpath(this.root);
    for (const source of this.records()) {
      signal?.throwIfAborted();
      if ((source.availability === "expired" || Date.now() - source.frozenAt > REMOTE_HOST_LIMITS.sourceTtlMs) &&
        !this.references.has(source.sourceId) && !this.protectedByExecution(source.sourceId)) await this.expire(source.sourceId);
    }
    const snapshots = new Set(this.records().map((source) => source.snapshotId));
    let scanned = 0;
    for await (const entry of await opendir(this.root)) {
      signal?.throwIfAborted();
      if (++scanned > REMOTE_HOST_LIMITS.snapshotEntries) throw new RemoteHostError("snapshot_limit", "The snapshot orphan scan budget is full.", "storage");
      if (!UUID_PATTERN.test(entry.name)) throw new RemoteHostError("storage_corrupt", "An unrecognized entry is present in private snapshot storage.", "storage");
      if (!snapshots.has(entry.name)) await rm(this.folder(entry.name), { recursive: true, force: true });
    }
    this.syncMaintenance();
  }

  private protectedByExecution(sourceId: string): boolean {
    const row = this.database.connection.prepare(`SELECT 1 AS present FROM remote_executions
      WHERE json_extract(document, '$.sourceId') = ?
      AND state IN ('queued', 'dispatching', 'running', 'verifying', 'cancel_requested',
        'execution_unknown', 'reconciling', 'needs_review') LIMIT 1`).get(sourceId);
    return Boolean(row);
  }
}
