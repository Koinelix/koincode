import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";
import { GENERAL_CONTROL_REPLY_MAX, GENERAL_CONTROL_ID_LIMIT, encodeGeneralControlRequest, parseGeneralControlMessage,
  assertGeneralControlReply, type GeneralControlRequest, type GeneralControlReply, type GeneralControlSnapshot, type GeneralControlEvent } from "./publicControlProtocol.js";

export class GeneralControlError extends Error {
  constructor(readonly code: string) { super(code); }
}
type Pending = { request: GeneralControlRequest; wire: Buffer; written: boolean; reply?: GeneralControlReply; expired: boolean; canceled: boolean;
  settled: boolean; resolve(value: GeneralControlReply): void; reject(error: GeneralControlError): void; timer: ReturnType<typeof setTimeout>;
  expires: number; cleanup(): void };
type Options = { readable: Readable; writable: Writable; windowId: string; isCurrent(): boolean; maximumMs?: number;
  onEvent?(value: GeneralControlEvent): void; onInvalidated?(): void; onBroken?(): void; onDrained?(): void };
const error = (code = "GENERAL_CONTROL_UNAVAILABLE") => new GeneralControlError(code);

/** Public pipe ownership only. It owns no native wallet, grant, database or key. */
export class GeneralControlChannel {
  private readonly maximum: number;
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (value: GeneralControlError) => void;
  private readyWaiter?: { finish(error?: GeneralControlError): void };
  private startup: ReturnType<typeof setTimeout>;
  private controlId?: string;
  private nextSequence = 1;
  private delivery = 0;
  private generation = 0;
  private viewId?: string;
  private readonly views = new Set<string>();
  private readonly requestIds = new Set<string>();
  private view?: GeneralControlSnapshot;
  private business?: Pending;
  private control?: Pending;
  private opening = false;
  private closing = false;
  private closeAck = false;
  private closingPromise?: Promise<void>;
  private closeResolve?: () => void;
  private closeReject?: (value: GeneralControlError) => void;
  private failure?: GeneralControlError;
  private ended = false;
  private drainNotified = false;
  private closeDeliveryQueued = false;
  private lastTime = performance.now();
  private header = Buffer.alloc(4);
  private headerUsed = 0;
  private body?: Buffer;
  private bodyUsed = 0;
  constructor(private readonly options: Options) {
    this.maximum = options.maximumMs ?? 30000;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.windowId) || typeof options.isCurrent !== "function" ||
      !Number.isSafeInteger(this.maximum) || this.maximum < 1 || this.maximum > 30000) throw error();
    this.ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    void this.ready.catch(() => {});
    this.startup = setTimeout(() => this.fail("GENERAL_OPERATION_TIMEOUT"), this.maximum); this.startup.unref();
    options.readable.on("data", (chunk: unknown) => this.ingest(chunk));
    options.readable.on("error", () => this.fail());
    options.readable.once("end", () => {
      this.ended = true;
      const ack = this.closeAck || this.control?.request.command === "close" && this.control.reply?.status === "ok";
      if (this.headerUsed || this.body || !this.closing || !ack || this.business && !this.business.reply) this.fail();
    });
    options.readable.once("close", () => { if (!this.ended) this.fail(); });
    options.writable.on("error", () => this.fail());
    options.writable.once("close", () => { if (!this.isDrained()) this.fail(); });
  }
  start(): Promise<void> { return this.ready; }
  snapshotValue(): GeneralControlSnapshot | undefined {
    if (this.view && (!this.current() || this.closing || this.failure)) this.invalidate();
    return this.view;
  }
  failureCode(): string | undefined { return this.failure?.code; }
  closingRequested(): boolean { return this.closing; }
  isDrained(): boolean { return !this.failure && this.closeAck && !this.business && !this.control && !this.opening; }
  transportFailed(): void { this.fail(); }
  private now(): number {
    const now = performance.now();
    if (!Number.isFinite(now) || now < this.lastTime) { this.fail(); throw error(); }
    this.lastTime = now; return now;
  }
  private current(): boolean {
    try { const value: unknown = this.options.isCurrent(); if (value instanceof Promise) void value.catch(() => {}); return value === true; }
    catch { return false; }
  }
  private invalidate(): void {
    this.view = undefined;
    try {
      const result: unknown = this.options.onInvalidated?.(); if (result instanceof Promise) void result.catch(() => {});
      if (result !== undefined) this.fail();
    } catch { this.fail(); }
  }
  private fail(code = "GENERAL_CONTROL_UNAVAILABLE"): void {
    if (this.failure) return;
    this.failure = error(code); clearTimeout(this.startup); this.view = undefined;
    this.body?.fill(0); this.body = undefined; this.header.fill(0);
    this.readyReject(this.failure); this.readyWaiter?.finish(this.failure); this.closeReject?.(this.failure);
    for (const pending of [this.business, this.control]) if (pending) {
      clearTimeout(pending.timer); pending.cleanup(); this.reject(pending, this.failure);
    }
    try { const result: unknown = this.options.onInvalidated?.(); if (result instanceof Promise) void result.catch(() => {}); }
    catch { /* No caller exception crosses the public boundary. */ }
    try { this.options.onBroken?.(); } catch { /* The actual process owner retains unknown drainage. */ }
  }
  private reject(pending: Pending, failure: GeneralControlError): void {
    if (!pending.settled) { pending.settled = true; pending.reject(failure); }
  }
  private ingest(chunk: unknown): void {
    if (this.failure) return;
    try {
      if (!(chunk instanceof Uint8Array) || chunk.buffer instanceof SharedArrayBuffer || this.ended || this.isDrained()) throw error();
      this.now(); let offset = 0;
      while (offset < chunk.byteLength && !this.failure) {
        if (!this.body) {
          const count = Math.min(4 - this.headerUsed, chunk.byteLength - offset);
          this.header.set(chunk.subarray(offset, offset + count), this.headerUsed); this.headerUsed += count; offset += count;
          if (this.headerUsed < 4) continue;
          const size = this.header.readUInt32BE(); if (!size || size > GENERAL_CONTROL_REPLY_MAX) throw error();
          this.body = Buffer.alloc(size); this.bodyUsed = 0;
        }
        const count = Math.min(this.body.length - this.bodyUsed, chunk.byteLength - offset);
        this.body.set(chunk.subarray(offset, offset + count), this.bodyUsed); this.bodyUsed += count; offset += count;
        if (this.bodyUsed === this.body.length) {
          const body = this.body; this.body = undefined; this.headerUsed = 0; this.bodyUsed = 0;
          try { this.receive(parseGeneralControlMessage(body)); } finally { body.fill(0); }
        }
      }
    } catch { this.fail(); }
  }
  private receive(message: ReturnType<typeof parseGeneralControlMessage>): void {
    if (this.isDrained()) throw error();
    if (!this.controlId) {
      if (message.format !== "koincode-general-control-hello" || this.closing) throw error();
      this.controlId = message.controlId; clearTimeout(this.startup); this.readyResolve(); this.readyWaiter?.finish(); return;
    }
    if (message.format === "koincode-general-control-hello" || message.controlId !== this.controlId || message.deliverySequence !== this.delivery + 1) throw error();
    this.delivery = message.deliverySequence;
    if (message.format === "koincode-general-control-event") {
      if (this.viewId && message.viewId !== this.viewId || message.generation < this.generation ||
        message.event === "invalidated" && message.generation <= this.generation) throw error();
      this.viewId = message.viewId; this.views.add(message.viewId); this.generation = message.generation;
      if (this.views.size > GENERAL_CONTROL_ID_LIMIT) throw error();
      this.invalidate(); if (this.failure) return;
      const result: unknown = this.options.onEvent?.(message); if (result instanceof Promise) void result.catch(() => {});
      if (result !== undefined) throw error(); return;
    }
    const pending = this.business?.request.requestId === message.requestId ? this.business : this.control?.request.requestId === message.requestId ? this.control : undefined;
    if (!pending || pending.reply || pending.request.sequence !== message.sequence || message.windowId !== this.options.windowId) throw error();
    assertGeneralControlReply(pending.request.command, message);
    if (message.status === "ok" && pending.request.command === "snapshot") {
      const value = message.body as GeneralControlSnapshot;
      if (value.generation <= this.generation || this.views.has(value.viewId)) throw error();
      this.viewId = value.viewId; this.views.add(value.viewId); this.generation = value.generation;
      if (this.views.size > GENERAL_CONTROL_ID_LIMIT) throw error();
    }
    pending.reply = message; this.finish(pending);
  }
  private finish(pending: Pending): void {
    if (!pending.written || !pending.reply || this.failure) return;
    const late = pending.expired || this.now() >= pending.expires;
    if (late) { pending.expired = true; this.invalidate(); }
    clearTimeout(pending.timer); pending.cleanup(); const reply = pending.reply;
    if (this.control === pending) {
      this.control = undefined;
      if (pending.request.command === "close") {
        if (reply.status !== "ok" || late) { this.fail(late ? "GENERAL_OPERATION_TIMEOUT" : undefined); return; }
        this.closeAck = true;
      }
    } else if (this.business === pending) this.business = undefined;
    else { this.fail(); return; }
    if (!pending.settled) {
      if (late) this.reject(pending, error("GENERAL_OPERATION_TIMEOUT"));
      else if (pending.canceled || !this.current() || this.closing && pending.request.command !== "close") this.reject(pending, error("GENERAL_OPERATION_CANCELED"));
      else if (reply.status !== "ok") this.reject(pending, error(reply.code));
      else {
        if (pending.request.command === "snapshot") {
          this.invalidate();
          if (!this.failure && !this.closing && this.current()) this.view = reply.body as GeneralControlSnapshot;
          else { this.reject(pending, this.failure ?? error("GENERAL_OPERATION_CANCELED")); }
        }
        if (!pending.settled) { pending.settled = true; if (!this.failure) pending.resolve(reply); else pending.reject(this.failure); }
      }
    }
    if (late && pending.request.command !== "close") void this.close().catch(() => {});
    this.pumpClose(); this.checkClose();
  }
  private issue(command: GeneralControlRequest["command"], body: GeneralControlRequest["body"], expires: number,
    business: boolean, signal?: AbortSignal): Promise<GeneralControlReply> {
    if (!this.controlId || this.failure || this.ended || this.nextSequence > GENERAL_CONTROL_ID_LIMIT || (business ? this.business || this.control : this.control)) throw error();
    if (business && this.nextSequence > GENERAL_CONTROL_ID_LIMIT - 2) { void this.close().catch(() => {}); throw error(); }
    const request = { format: "koincode-general-control-request", version: 1, controlId: this.controlId, sequence: this.nextSequence++,
      requestId: randomUUID(), windowId: this.options.windowId, command, body } as GeneralControlRequest;
    if (this.requestIds.has(request.requestId)) throw error(); this.requestIds.add(request.requestId);
    const wire = encodeGeneralControlRequest(request);
    return new Promise((resolve, reject) => {
      const abort = () => { pending.canceled = true; this.invalidate(); this.cancelPending(pending); };
      const pending: Pending = { request, wire, written: false, expired: false, canceled: false, settled: false, resolve, reject, expires,
        cleanup: () => signal?.removeEventListener("abort", abort), timer: setTimeout(() => {
          pending.expired = true; this.invalidate(); this.reject(pending, error("GENERAL_OPERATION_TIMEOUT"));
          if (command === "close") this.fail("GENERAL_OPERATION_TIMEOUT"); else void this.close().catch(() => {});
        }, Math.max(1, expires - this.now())) };
      pending.timer.unref(); if (business) this.business = pending; else this.control = pending;
      try {
        this.options.writable.write(wire, (failure) => {
          if (pending.written) { this.fail(); return; }
          pending.written = true; wire.fill(0);
          if (failure) this.fail(); else { try { this.now(); this.finish(pending); } catch { this.fail(); } }
        });
        if (signal && this.business === pending && !this.failure) { signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); }
      } catch { this.fail(); }
    });
  }
  private cancelPending(pending: Pending): void {
    if (this.failure || this.closing || this.business !== pending || this.control) return;
    try { void this.issue("cancel", { targetRequestId: pending.request.requestId }, this.now() + this.maximum, false).catch(() => {}); }
    catch { this.fail(); }
  }
  private async request(command: "snapshot" | "open_manager", signal?: AbortSignal): Promise<GeneralControlReply> {
    const expires = this.now() + this.maximum;
    if (this.failure) throw this.failure;
    if (this.closing || !this.current() || signal?.aborted) throw error("GENERAL_OPERATION_CANCELED");
    if (this.business || this.control || this.opening) throw error("GENERAL_OPERATION_BUSY");
    this.opening = true;
    try {
      await this.waitReady(signal);
      if (this.failure) throw this.failure;
      if (this.closing || !this.current() || signal?.aborted) throw error("GENERAL_OPERATION_CANCELED");
      if (this.now() >= expires) { void this.close().catch(() => {}); throw error("GENERAL_OPERATION_TIMEOUT"); }
      return this.issue(command, {}, expires, true, signal);
    } finally { this.opening = false; this.checkClose(); }
  }
  private waitReady(signal?: AbortSignal): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.controlId) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const abort = () => waiter.finish(error("GENERAL_OPERATION_CANCELED"));
      const waiter = { finish: (failure?: GeneralControlError) => {
        if (this.readyWaiter !== waiter) return;
        this.readyWaiter = undefined; signal?.removeEventListener("abort", abort);
        if (failure) reject(failure); else resolve();
      } };
      this.readyWaiter = waiter; signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    });
  }
  private deliveryCurrent(expires: number): void {
    if (this.failure) throw this.failure;
    if (this.now() >= expires) { this.invalidate(); void this.close().catch(() => {}); throw error("GENERAL_OPERATION_TIMEOUT"); }
    if (!this.current() || this.closing || this.failure) { this.invalidate(); void this.close().catch(() => {}); throw this.failure ?? error("GENERAL_OPERATION_CANCELED"); }
  }
  async snapshot(signal?: AbortSignal): Promise<GeneralControlSnapshot> {
    const expires = this.now() + this.maximum, reply = await this.request("snapshot", signal); this.deliveryCurrent(expires);
    if (signal?.aborted) { this.invalidate(); throw error("GENERAL_OPERATION_CANCELED"); }
    if (this.view !== reply.body || this.business?.request.command === "snapshot") throw error("GENERAL_OPERATION_CANCELED");
    return reply.body as GeneralControlSnapshot;
  }
  async openManager(signal?: AbortSignal): Promise<void> { const expires = this.now() + this.maximum; await this.request("open_manager", signal); this.deliveryCurrent(expires); }
  close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closing = true;
    this.closingPromise = new Promise<void>((resolve, reject) => { this.closeResolve = resolve; this.closeReject = reject; });
    this.invalidate();
    if (this.failure) this.closeReject!(this.failure);
    else if (!this.controlId) this.fail();
    else this.pumpClose();
    return this.closingPromise;
  }
  private pumpClose(): void {
    if (!this.closing || this.failure || this.closeAck || this.control) return;
    try { void this.issue("close", {}, this.now() + this.maximum, false).catch(() => {}); }
    catch { this.fail(); }
  }
  private checkClose(): void {
    if (!this.isDrained()) return;
    if (!this.drainNotified) {
      this.drainNotified = true;
      try { this.options.onDrained?.(); } catch { this.fail(); return; }
    }
    if (!this.closeDeliveryQueued) {
      this.closeDeliveryQueued = true;
      queueMicrotask(() => { if (this.isDrained()) this.closeResolve?.(); else this.closeReject?.(this.failure ?? error()); });
    }
  }
}
