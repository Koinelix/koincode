import { Duplex } from "node:stream";
import { WalletError } from "../domain/errors.js";
import { GENERAL_SESSION_METADATA_MAX, GENERAL_SESSION_VALUE_MAX, decodeGeneralSessionHello, decodeGeneralSessionReply,
  encodeGeneralSessionRequest, parseGeneralSessionReply, validateGeneralSessionRequest,
  type GeneralSessionRequest, type GeneralSessionReply } from "./generalSessionProtocol.js";

type Input<R = GeneralSessionRequest> = R extends GeneralSessionRequest ? Omit<R, "format" | "version" | "sessionId" | "sequence"> : never;
export type GeneralSessionInput = Input;
export type GeneralSessionResponse = { reply: GeneralSessionReply; value: Uint8Array };
type Lifetime = { assertCurrent(): void; invalidate(): void };
type Pending = { request: GeneralSessionRequest; wire: Uint8Array; expiresAt: number; attempted: boolean; sent: boolean;
  reply?: GeneralSessionResponse; timer?: ReturnType<typeof setTimeout>;
  resolve(value: GeneralSessionResponse): void; reject(error: WalletError): void };
const owned = new WeakSet<Duplex>();
const closedError = (): void => {};
const FRAME_MAX = 8 + GENERAL_SESSION_METADATA_MAX + GENERAL_SESSION_VALUE_MAX;
const unavailable = () => new WalletError("GENERAL_PROTECTION_UNAVAILABLE", "The protected wallet session is unavailable.");
const busy = () => new WalletError("GENERAL_OPERATION_BUSY", "The protected wallet session already has pending work.");
const canceled = () => new WalletError("GENERAL_OPERATION_CANCELED", "The protected wallet operation was canceled.");
const uncertain = () => new WalletError("GENERAL_REGISTRATION_UNCERTAIN", "The original protected operation requires inspection.");

/** Private transport ownership only. An actual native factory must establish
 * code/peer/profile/child identity before lending this exclusive stream.
 * transportClosed never proves native worker, OS IO or UID-lock drainage. */
export class GeneralSessionChannel {
  readonly ready: Promise<string>;
  readonly transportClosed: Promise<void>;
  private resolveReady!: (sessionId: string) => void;
  private rejectReady!: (error: WalletError) => void;
  private resolveClosed!: () => void;
  private sessionId?: string;
  private helloReceived = false;
  private readyDelivered = false;
  private faulted = false;
  private closed = false;
  private closing = false;
  private invalidated = false;
  private checking = false;
  private queued = false;
  private nextSequence = 1;
  private readonly requestIds = new Set<string>();
  private business?: Pending;
  private control?: Pending;
  private writing?: Pending;
  private terminalClose?: Pending;
  private lastTime = performance.now();
  private readonly startupExpiresAt = this.lastTime + 30000;
  private startup?: ReturnType<typeof setTimeout>;
  private frameTimer?: ReturnType<typeof setTimeout>;
  private frameExpiresAt?: number;
  private header = Buffer.alloc(4);
  private used = 0;
  private stage: "metadata_length" | "metadata" | "value_length" | "value" = "metadata_length";
  private metadata?: Buffer;
  private incoming?: Pending;
  private wire?: Buffer;

  constructor(private readonly stream: Duplex, private readonly lifetime: Lifetime, private readonly signal: AbortSignal) {
    if (!(stream instanceof Duplex) || owned.has(stream) || stream.destroyed || stream.readableObjectMode || stream.writableObjectMode ||
        stream.readableEncoding || stream.readableFlowing || stream.listenerCount("data") || stream.listenerCount("readable") ||
        !(signal instanceof AbortSignal) || typeof lifetime?.assertCurrent !== "function" || typeof lifetime?.invalidate !== "function") throw unavailable();
    owned.add(stream);
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.transportClosed = new Promise((resolve) => { this.resolveClosed = resolve; });
    // The caller may be waiting for its native factory before observing ready.
    void this.ready.catch(() => {});
    stream.pause(); stream.on("data", this.data); stream.on("error", this.error); stream.on("end", this.end); stream.on("close", this.close);
    signal.addEventListener("abort", this.abort, { once: true });
    this.startup = setTimeout(() => this.fail(), 30000); this.startup.unref();
    try { this.current(); stream.resume(); } catch { this.fail(); }
  }

  /** The original Host scope supplies this clock's earlier deadline. No queue,
   * retry, auth decision or scope transition is inferred from a reply. */
  async request(input: GeneralSessionInput, expiresAt: number, value: Uint8Array = new Uint8Array()): Promise<GeneralSessionResponse> {
    if (this.faulted || this.closed || !this.readyDelivered || !this.sessionId) throw unavailable();
    try { this.current(); } catch { this.fail(); throw unavailable(); }
    if (!input || typeof input !== "object" || ["format", "version", "sessionId", "sequence"].some((key) => key in input)) throw unavailable();
    const now = this.lastTime;
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt - now > 360000 || this.nextSequence > 65536) throw unavailable();
    const request = validateGeneralSessionRequest({ ...input, format: "koincode-general-session-request", version: 1,
      sessionId: this.sessionId, sequence: this.nextSequence });
    const control = request.command === "cancel" || request.command === "close";
    if (this.closing || (control ? this.control : this.business || this.control)) throw busy();
    if (request.command === "cancel" && (!this.business || this.business.reply ||
        request.body.targetRequestId !== this.business.request.requestId || request.operationId !== this.business.request.operationId)) throw unavailable();
    if (this.requestIds.has(request.requestId)) throw unavailable();
    const wire = encodeGeneralSessionRequest(request, value);
    // Admission precedes stream IO and no asynchronous lifetime callback is accepted.
    this.nextSequence++; this.requestIds.add(request.requestId);
    const extendedBegin = request.command === "begin" && request.body.kind !== "inspection";
    const deadline = Math.min(expiresAt, now + (extendedBegin ? 360000 : 30000));
    return new Promise<GeneralSessionResponse>((resolve, reject) => {
      const pending: Pending = { request, wire, expiresAt: deadline, attempted: false, sent: false, resolve, reject };
      pending.timer = setTimeout(() => this.fail(), Math.max(1, Math.ceil(deadline - now))); pending.timer.unref();
      if (control) this.control = pending; else this.business = pending;
      if (request.command === "close") this.closing = true;
      this.send();
    });
  }

  /** Revokes transport availability immediately, but awaits an actual stream
   * close. The enclosing native owner must separately await broker/worker reap. */
  disposeTransport(): Promise<void> { this.fail(); return this.transportClosed; }

  private current(): void {
    const now = performance.now();
    if (this.faulted || this.signal.aborted || this.checking || !Number.isFinite(now) || now < this.lastTime) throw unavailable();
    this.lastTime = now; this.checking = true;
    try {
      const result: unknown = this.lifetime.assertCurrent();
      if (result !== undefined) {
        if (result instanceof Promise) void result.catch(() => {});
        throw unavailable();
      }
      if (this.faulted || this.signal.aborted) throw unavailable();
      const finished = performance.now();
      if (!Number.isFinite(finished) || finished < this.lastTime) throw unavailable();
      this.lastTime = finished;
    } finally { this.checking = false; }
  }
  private revoke(): void {
    if (this.invalidated) return;
    this.invalidated = true;
    try { const result: unknown = this.lifetime.invalidate(); if (result instanceof Promise) void result.catch(() => {}); }
    catch { /* Revocation failure is never a new authority or a close receipt. */ }
  }
  private send(): void {
    if (this.faulted || this.closed || this.writing) return;
    const pending = [this.business, this.control].find((item) => item && !item.attempted);
    if (!pending) return;
    try {
      this.current(); if (this.lastTime >= pending.expiresAt) throw unavailable();
      this.writing = pending; pending.attempted = true;
      this.stream.write(pending.wire, (error?: Error | null) => {
        pending.wire.fill(0); pending.sent = true;
        if (this.writing === pending) this.writing = undefined;
        if (this.closed) return;
        if (error) { this.fail(); return; }
        this.deliverLater(); this.send();
      });
    } catch { this.fail(); }
  }
  private resetFrame(): void {
    clearTimeout(this.frameTimer); this.frameTimer = undefined; this.frameExpiresAt = undefined;
    this.header.fill(0); this.metadata?.fill(0); this.wire?.fill(0);
    this.metadata = undefined; this.wire = undefined; this.incoming = undefined; this.stage = "metadata_length"; this.used = 0;
  }
  private metadataReady(): void {
    if (!this.metadata) throw unavailable();
    if (!this.helloReceived) {
      const wire = Buffer.alloc(this.metadata.byteLength + 8);
      wire.writeUInt32BE(this.metadata.byteLength, 0); wire.set(this.metadata, 4);
      try { decodeGeneralSessionHello(wire); } finally { wire.fill(0); }
      return;
    }
    for (const pending of [this.business, this.control]) if (pending && pending.attempted) {
      try {
        parseGeneralSessionReply(this.metadata, pending.request, 0);
        if (pending.reply) throw unavailable();
        this.incoming = pending; return;
      } catch { /* Try only the other original outstanding envelope. */ }
    }
    throw unavailable();
  }
  private completeFrame(): void {
    if (!this.wire) throw unavailable();
    if (!this.helloReceived) {
      const hello = decodeGeneralSessionHello(this.wire); this.sessionId = hello.sessionId; this.helloReceived = true;
    } else {
      const pending = this.incoming;
      if (!pending || pending.reply) throw unavailable();
      pending.reply = decodeGeneralSessionReply(this.wire, pending.request);
    }
    this.resetFrame(); this.deliverLater();
  }
  private data = (chunk: unknown): void => {
    if (this.faulted) return;
    try {
      this.current();
      if (this.frameExpiresAt !== undefined && this.lastTime >= this.frameExpiresAt) throw unavailable();
      if (!(chunk instanceof Uint8Array) || chunk.buffer instanceof SharedArrayBuffer || chunk.byteLength > 2 * FRAME_MAX) throw unavailable();
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (this.helloReceived && this.stage === "metadata_length" && !this.used &&
            ![this.business, this.control].some((pending) => pending?.attempted && !pending.reply)) throw unavailable();
        if (!this.frameTimer) { this.frameExpiresAt = this.lastTime + 30000; this.frameTimer = setTimeout(() => this.fail(), 30000); this.frameTimer.unref(); }
        const target = this.stage === "metadata" ? this.metadata : this.stage === "value" ? this.wire : this.header;
        if (!target) throw unavailable();
        const count = Math.min(target.byteLength - this.used, chunk.byteLength - offset);
        target.set(chunk.subarray(offset, offset + count), this.used); this.used += count; offset += count;
        if (this.used < target.byteLength) continue;
        if (this.stage === "metadata_length") {
          const size = this.header.readUInt32BE(0);
          if (!size || size > GENERAL_SESSION_METADATA_MAX) throw unavailable();
          this.metadata = Buffer.alloc(size); this.stage = "metadata"; this.used = 0;
        } else if (this.stage === "metadata") {
          this.metadataReady(); this.stage = "value_length"; this.used = 0; this.header.fill(0);
        } else if (this.stage === "value_length") {
          const size = this.header.readUInt32BE(0);
          if (size > GENERAL_SESSION_VALUE_MAX || !this.metadata) throw unavailable();
          if (!this.helloReceived) { if (size) throw unavailable(); }
          else if (!this.incoming || this.incoming.reply) throw unavailable();
          else parseGeneralSessionReply(this.metadata, this.incoming.request, size);
          this.wire = Buffer.alloc(this.metadata.byteLength + size + 8);
          this.wire.writeUInt32BE(this.metadata.byteLength, 0); this.wire.set(this.metadata, 4); this.wire.writeUInt32BE(size, this.metadata.byteLength + 4);
          this.used = this.metadata.byteLength + 8; this.stage = "value";
          if (!size) this.completeFrame();
        } else this.completeFrame();
      }
    } catch { this.fail(); }
  };
  private deliverLater(): void {
    if (this.queued || this.faulted) return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; this.deliver(); });
  }
  private deliver(): void {
    if (this.faulted) return;
    try {
      if (!this.closed) this.current();
      if ([this.business, this.control].some((pending) => pending && this.lastTime >= pending.expiresAt)) throw unavailable();
      if (this.helloReceived && !this.readyDelivered) {
        if (this.closed || !this.sessionId || this.lastTime >= this.startupExpiresAt) throw unavailable();
        clearTimeout(this.startup); this.startup = undefined; this.readyDelivered = true; this.resolveReady(this.sessionId);
      }
      const business = this.business;
      if (business?.sent && business.reply) {
        this.business = undefined; clearTimeout(business.timer);
        if (this.closing && business.reply.value.byteLength) { business.reply.value.fill(0); business.reject(canceled()); }
        else business.resolve(business.reply);
      }
      const control = this.control;
      if (control?.sent && control.reply && !this.business) {
        this.control = undefined;
        if (control.request.command === "close") {
          if (control.reply.reply.status === "ok") {
            this.terminalClose = control;
            if (this.closed) { clearTimeout(control.timer); this.revoke(); control.resolve(control.reply); this.terminalClose = undefined; }
            else this.stream.destroy();
          } else { clearTimeout(control.timer); control.resolve(control.reply); this.fail(); }
        } else { clearTimeout(control.timer); control.resolve(control.reply); }
      }
    } catch { this.fail(); }
  }
  private error = (): void => { this.fail(); };
  private abort = (): void => { this.fail(); };
  private end = (): void => {
    if (this.faulted) return;
    const closeReply = this.terminalClose?.reply?.reply ?? (this.control?.request.command === "close" ? this.control.reply?.reply : undefined);
    if (this.stage !== "metadata_length" || this.used || closeReply?.status !== "ok" || (this.business && !this.business.reply)) this.fail();
    else this.deliverLater();
  };
  private close = (): void => {
    if (this.closed) return;
    this.closed = true;
    if (this.writing) { this.writing.wire.fill(0); this.writing.sent = true; this.writing = undefined; }
    const terminal = this.terminalClose;
    if (terminal?.reply) { clearTimeout(terminal.timer); this.terminalClose = undefined; this.revoke(); terminal.resolve(terminal.reply); }
    else if (!this.faulted && this.control?.request.command === "close" && this.control.reply?.reply.status === "ok" &&
        (!this.business || this.business.reply)) this.deliver();
    else this.fail();
    this.resetFrame(); clearTimeout(this.startup);
    this.signal.removeEventListener("abort", this.abort);
    this.stream.off("data", this.data); this.stream.off("end", this.end); this.stream.off("close", this.close);
    this.stream.off("error", this.error); this.stream.on("error", closedError); this.requestIds.clear();
    this.resolveClosed();
  };
  private fail(): void {
    if (this.faulted) return;
    this.faulted = true; this.revoke(); this.rejectReady(unavailable());
    clearTimeout(this.startup); this.startup = undefined; this.resetFrame();
    for (const pending of [this.business, this.control, this.terminalClose]) if (pending) {
      clearTimeout(pending.timer); pending.reply?.value.fill(0);
      if (pending !== this.writing) pending.wire.fill(0);
      const persistent = pending.attempted && (["begin", "write", "publish", "end", "close"].includes(pending.request.command) ||
        (pending.request.command === "resource" && pending.request.body.action !== "inspect"));
      pending.reject(persistent ? uncertain() : unavailable());
    }
    this.business = undefined; this.control = undefined; this.terminalClose = undefined;
    if (!this.closed) this.stream.destroy();
  }
}
