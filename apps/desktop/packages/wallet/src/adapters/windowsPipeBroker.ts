import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Duplex } from "node:stream";
import { WalletError, requireWallet } from "../domain/errors.js";
import { windowsNativeHelper, windowsNativeEnvironment } from "./windowsNative.js";
export type WindowsPeer = { platform: "win32"; pid: number; sid: string; started: string };
const DATA_LIMIT = 2 * 1024 * 1024;
const LIMIT = DATA_LIMIT + 5;
const unavailable = () => new WalletError("LOCAL_TRANSPORT_UNAVAILABLE", "The authenticated Windows wallet pipe is unavailable.");

export class WindowsPipeStream extends Duplex {
  private nativeEnded = false;
  constructor(readonly peer: WindowsPeer, readonly connectionId: number, private readonly broker: WindowsPipeBroker) {
    super({ highWaterMark: 65536 });
  }
  // A multiplexed native stdout must keep draining close/control frames.
  override _read(): void {}
  override _write(bytes: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try { this.broker.send(2, this.connectionId, bytes, callback); } catch { callback(unavailable()); }
  }
  override _final(callback: (error?: Error | null) => void): void {
    // Named pipes have no socket half-close; caller EOF terminates this session.
    try { this.broker.send(3, this.connectionId, Buffer.alloc(0), callback); } catch { callback(unavailable()); }
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.nativeEnded) { try { this.broker.send(3, this.connectionId); } catch { /* Native close may already be in flight. */ } }
    callback(error);
  }
  receive(bytes: Buffer): void {
    if (this.destroyed) return;
    if (this.readableLength + bytes.length > DATA_LIMIT) {
      this.destroy(new WalletError("MCP_BUSY", "The Windows pipe input queue is full."));
      return;
    }
    this.push(bytes);
  }
  nativeClose(): void { this.nativeEnded = true; this.push(null); this.destroy(); }
}

/** One private child owns every actual pipe handle and kernel peer observation. */
export class WindowsPipeBroker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly streams = new Map<number, WindowsPipeStream>();
  private buffer = Buffer.alloc(0);
  private stopping = false;
  private completed = false;
  private readonly readyResolve: () => void;
  private readonly readyReject: (error: Error) => void;
  readonly ready: Promise<void>;
  private readonly exited: Promise<number | null>;
  constructor(mode: "server" | "client", path: string, private readonly opened: (stream: WindowsPipeStream) => void) {
    requireWallet(/^\\\\\.\\pipe\\KoinCodeWallet-v1-[0-9a-f]{64}$/.test(path), "LOCAL_TRANSPORT_UNAVAILABLE", "The Windows wallet endpoint is invalid.");
    let resolveReady!: () => void, rejectReady!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    this.readyResolve = resolveReady; this.readyReject = rejectReady;
    this.child = spawn(windowsNativeHelper(), [mode, path], { env: windowsNativeEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.fail());
    this.child.stdout.on("data", (bytes: Buffer) => { try { this.receive(bytes); } catch { this.fail(); } });
    this.child.once("error", () => this.fail());
    const timer = setTimeout(() => this.fail(), 10000);
    void this.ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
    this.exited = new Promise(resolve => this.child.once("close", code => {
      this.completed = true; clearTimeout(timer); this.readyReject(unavailable());
      for (const stream of this.streams.values()) stream.nativeClose();
      this.streams.clear(); this.buffer.fill(0); resolve(code);
    }));
  }
  private fail(): void {
    this.stopping = true;
    this.readyReject(unavailable());
    for (const stream of this.streams.values()) stream.nativeClose();
    this.streams.clear(); this.child.kill();
  }
  private receive(bytes: Buffer): void {
    requireWallet(this.buffer.length + bytes.length <= LIMIT * 2 + 8, "MCP_BUSY", "The Windows broker input queue is full.");
    this.buffer = Buffer.concat([this.buffer, bytes]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE();
      requireWallet(length >= 5 && length <= LIMIT, "LOCAL_TRANSPORT_UNAVAILABLE", "The Windows broker frame is invalid.");
      if (this.buffer.length < length + 4) return;
      const frame = this.buffer.subarray(4, length + 4); this.buffer = this.buffer.subarray(length + 4);
      const kind = frame[0], id = frame.readUInt32LE(1), data = frame.subarray(5);
      if (kind === 5) { requireWallet(id === 0 && data.length === 0, "LOCAL_TRANSPORT_UNAVAILABLE", "Invalid Windows broker readiness."); this.readyResolve(); continue; }
      if (kind === 1) {
        requireWallet(!this.stopping && id > 0 && !this.streams.has(id) && data.length <= 1024 && this.streams.size < 32,
          "LOCAL_TRANSPORT_UNAVAILABLE", "Invalid Windows pipe connection.");
        const peer = JSON.parse(data.toString("utf8")) as WindowsPeer;
        requireWallet(Object.keys(peer).sort().join() === "pid,platform,sid,started" && peer.platform === "win32" &&
          Number.isSafeInteger(peer.pid) && peer.pid > 0 && /^S-1-[0-9-]{1,200}$/.test(peer.sid) && /^[0-9]{1,20}$/.test(peer.started),
        "CLIENT_IDENTITY_UNAVAILABLE", "The native Windows peer report is invalid.");
        const stream = new WindowsPipeStream(peer, id, this); this.streams.set(id, stream);
        this.opened(stream); this.readyResolve();
      } else if (kind === 2) this.streams.get(id)?.receive(Buffer.from(data));
      else if (kind === 3 && data.length === 0) { this.streams.get(id)?.nativeClose(); this.streams.delete(id); }
      else throw unavailable();
    }
  }
  send(kind: number, id: number, bytes: Buffer = Buffer.alloc(0), callback?: (error?: Error | null) => void): void {
    requireWallet(!this.completed && this.child.stdin.writable && bytes.length + 5 <= LIMIT &&
      this.child.stdin.writableLength + bytes.length + 9 <= LIMIT + 4,
    "MCP_BUSY", "The Windows broker output queue is unavailable.");
    const frame = Buffer.allocUnsafe(bytes.length + 9); frame.writeUInt32LE(bytes.length + 5); frame[4] = kind; frame.writeUInt32LE(id, 5); bytes.copy(frame, 9);
    this.child.stdin.write(frame, callback);
  }
  async close(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      for (const stream of this.streams.values()) stream.destroy();
      if (!this.completed) { try { this.send(4, 0); this.child.stdin.end(); } catch { this.child.kill(); } }
    }
    const timer = setTimeout(() => this.child.kill(), 20000);
    try { requireWallet(await this.exited === 0, "LOCAL_TRANSPORT_UNAVAILABLE", "Windows pipe shutdown could not be confirmed."); }
    finally { clearTimeout(timer); }
  }
}
