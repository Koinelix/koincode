import { Duplex } from "node:stream";
import { WalletError } from "../domain/errors.js";

/** Implemented by the sealed NAPI owner after its actual bootstrap. Shape alone
 * is never provenance; only the fixed private Host entry loads the real module. */
export interface GeneralNativeTransportPort {
  readonly mode: "manager" | "inspection";
  assertCurrent(): void;
  bindWindow(handle: Buffer, windowId: number, window: object, contents: object, session: object): void;
  readFrame(timeoutMs: number): Promise<Buffer>;
  writeFrame(frame: Buffer): Promise<void>;
  invalidate(): void;
  close(): "closed" | "busy" | "uncertain";
}
const unavailable = () => new WalletError("GENERAL_PROTECTION_UNAVAILABLE", "The protected wallet transport is unavailable.");
const uncertain = () => new WalletError("GENERAL_REGISTRATION_UNCERTAIN", "The original native owner has not safely drained.");

/** Byte ownership only. Original channel owns correlation and native broker
 * owns scope and durable facts. Never exposes the native socket descriptor. */
export class GeneralNativeTransport extends Duplex {
  readonly drained: Promise<void>;
  private resolveDrained!: () => void;
  private rejectDrained!: (error: Error) => void;
  private readonly active = new Set<Promise<unknown>>();
  private readonly invalidationObservers = new Set<() => void>();
  private stopped = false;
  private receiving = false;
  private helloPending = true;
  private expected = 1;
  constructor(private readonly native: GeneralNativeTransportPort) {
    super({ allowHalfOpen: false, autoDestroy: true, readableHighWaterMark: 1, writableHighWaterMark: 1 });
    this.drained = new Promise((resolve, reject) => { this.resolveDrained = resolve; this.rejectDrained = reject; });
    void this.drained.catch(() => {});
    queueMicrotask(() => this.receive());
  }
  assertCurrent(): void {
    if (this.stopped) throw unavailable();
    try {
      const result: unknown = this.native.assertCurrent();
      if (result !== undefined) { if (result instanceof Promise) void result.catch(() => {}); throw unavailable(); }
    } catch { this.destroy(unavailable()); throw unavailable(); }
  }
  onInvalidated(callback: () => void): () => void {
    this.assertCurrent();
    if (this.invalidationObservers.size >= 16) throw unavailable();
    this.invalidationObservers.add(callback); return () => { this.invalidationObservers.delete(callback); };
  }
  bindWindow(handle: Buffer, windowId: number, window: object, contents: object, session: object): void {
    this.assertCurrent(); this.native.bindWindow(handle, windowId, window, contents, session); this.assertCurrent();
  }
  override _read(): void { /* Native reads run only for hello or actual outstanding envelopes. */ }
  private track<T>(work: Promise<T>): Promise<T> {
    this.active.add(work); void work.finally(() => this.active.delete(work)).catch(() => {}); return work;
  }
  private receive(): void {
    if (this.stopped || this.receiving || !this.expected) return;
    this.receiving = true;
    let work: Promise<Buffer>;
    try { this.assertCurrent(); work = this.native.readFrame(this.helloPending ? 30_000 : 360_000); }
    catch { this.receiving = false; this.destroy(unavailable()); return; }
    this.track(work).then((frame) => {
      try {
        if (!Buffer.isBuffer(frame)) throw unavailable();
        if (this.stopped) return;
        this.assertCurrent();
        // The exclusive GeneralSessionChannel is already flowing and copies a
        // complete frame synchronously. Never queue secret bytes for an absent
        // consumer or allow a paused reader to retain the original raw frame.
        if (this.readableFlowing !== true || this.readableLength !== 0) throw unavailable();
        this.expected--; this.helloPending = false; this.push(frame);
      } finally { if (Buffer.isBuffer(frame)) frame.fill(0); }
    }).catch(() => this.destroy(unavailable())).finally(() => {
      this.receiving = false; this.receive();
    });
  }
  override _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.stopped || !Buffer.isBuffer(chunk) || this.expected >= 2) { callback(unavailable()); return; }
    let work: Promise<void>;
    try { this.assertCurrent(); work = this.native.writeFrame(chunk); this.expected++; }
    catch { callback(unavailable()); return; }
    // A cancel may be queued while the first actual broker response is pending.
    // Its reply is read by the same single native receiver, in either legal order.
    this.track(work).then(() => { if (this.stopped) callback(unavailable()); else { callback(); this.receive(); } }, () => callback(unavailable()));
    this.receive();
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.stopped = true;
    let invalidationFailed = false;
    try { this.native.invalidate(); } catch { invalidationFailed = true; }
    for (const listener of this.invalidationObservers) { try { listener(); } catch { /* Revocation observers cannot create a close receipt. */ } }
    this.invalidationObservers.clear();
    void Promise.allSettled(this.active).then(() => {
      let status: unknown;
      try { status = this.native.close(); } catch { status = "uncertain"; }
      if (invalidationFailed || status !== "closed") {
        const failure = uncertain(); this.rejectDrained(failure); callback(failure); return;
      }
      this.resolveDrained(); callback(error);
    });
  }
}
