import { createHash } from "node:crypto";
import type { GuardedWalletState } from "./guardedState.js";
import type { ResponseReservation } from "./requestPorts.js";
import { ResponseRetentionJournal } from "./responseRetentionJournal.js";
import { requireWallet } from "../domain/errors.js";
import { RESPONSE_LIMIT } from "../domain/requestValidation.js";

export interface RetainedResponseBlobs {
  putRetained(ref: string, bytes: Uint8Array, reservation: ResponseReservation): Promise<void>;
  get(ref: string): Promise<Uint8Array>;
  removeRetained(ref: string): Promise<void>;
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const clear = (bytes: Uint8Array | undefined) => {
  try { bytes?.fill(0); } catch { /* Detached adapter buffers cannot be cleared again. */ }
};

/** Internal lifecycle only. The host must retain the service lease until all operations settle. */
export class ResponseRetentionOwner {
  readonly journal: ResponseRetentionJournal;
  private readonly writes = new Map<string, Promise<void>>();
  private readonly cleanups = new Map<string, Promise<void>>();
  constructor(private readonly state: GuardedWalletState, private readonly blobs: RetainedResponseBlobs,
    private readonly now: () => number) {
    this.journal = new ResponseRetentionJournal(state);
  }
  write(id: string, raw: Uint8Array, context: Uint8Array, reservation: ResponseReservation,
    checkCurrent: () => void): Promise<void> {
    requireWallet(!this.writes.has(id), "RESPONSE_RETENTION_BUSY", "The retention is already writing.");
    requireWallet(raw.byteLength <= RESPONSE_LIMIT && context.byteLength > 0 && context.byteLength <= 1048576,
      "RESPONSE_RETENTION_UNAVAILABLE", "The retained response exceeds its bounds.");
    checkCurrent();
    const record = this.journal.writing(id, this.now());
    const body = Uint8Array.from(raw), binding = Uint8Array.from(context);
    const evidence = { rawByteLength: body.byteLength, rawSha256: digest(body),
      contextByteLength: binding.byteLength, contextSha256: digest(binding) };
    const operation = (async () => {
      try {
        await this.blobs.putRetained(record.rawRef, body, reservation);
        checkCurrent(); this.journal.writing(id, this.now());
        await this.blobs.putRetained(record.contextRef, binding, reservation);
        checkCurrent(); this.journal.writing(id, this.now());
        await this.journal.markReady(id, evidence);
      } finally { clear(body); clear(binding); }
    })();
    this.writes.set(id, operation);
    void operation.finally(() => this.writes.delete(id)).catch(() => {});
    return operation;
  }
  async read(id: string, checkCurrent: () => void): Promise<{ raw: Uint8Array; context: Uint8Array }> {
    checkCurrent();
    const record = this.journal.ready(id, this.now());
    let raw: Uint8Array | undefined, context: Uint8Array | undefined;
    try {
      raw = await this.blobs.get(record.rawRef);
      checkCurrent(); this.journal.ready(id, this.now());
      context = await this.blobs.get(record.contextRef);
      checkCurrent(); this.journal.ready(id, this.now());
      requireWallet(raw.byteLength === record.rawByteLength && digest(raw) === record.rawSha256 &&
        context.byteLength === record.contextByteLength && digest(context) === record.contextSha256,
      "RESPONSE_RETENTION_UNAVAILABLE", "Retained response completion evidence differs.");
      checkCurrent(); this.journal.ready(id, this.now());
      return { raw, context };
    } catch (error) { clear(raw); clear(context); throw error; }
  }
  cleanup(id: string): Promise<void> {
    const pending = this.cleanups.get(id);
    if (pending) return pending;
    const operation = (async () => {
      const record = await this.journal.beginDelete(id);
      if (record.state === "deleted") return;
      await this.writes.get(id)?.catch(() => {});
      await this.blobs.removeRetained(record.rawRef);
      await this.blobs.removeRetained(record.contextRef);
      await this.journal.markDeleted(id);
    })();
    this.cleanups.set(id, operation);
    void operation.finally(() => this.cleanups.delete(id)).catch(() => {});
    return operation;
  }
  async cleanupIncomplete(limit = 50): Promise<number> {
    requireWallet(Number.isSafeInteger(limit) && limit > 0 && limit <= 50,
      "RESPONSE_RETENTION_UNAVAILABLE", "Cleanup requires a bounded batch.");
    const state = this.state.snapshot(), now = this.now();
    requireWallet(Number.isSafeInteger(now), "RESPONSE_RETENTION_UNAVAILABLE", "Cleanup time is invalid.");
    const requests = new Map(state.transport?.requests.map(r => [r.requestId, r]));
    const records = (state.transport?.retentions ?? []).filter(r => r.state !== "deleted" &&
      (r.state !== "ready" || r.epoch !== state.managementEpoch ||
        requests.get(r.requestId)?.canceled || now >= r.expiresAt)).slice(0, limit);
    for (const record of records) await this.cleanup(record.retentionId);
    return records.length;
  }
}
