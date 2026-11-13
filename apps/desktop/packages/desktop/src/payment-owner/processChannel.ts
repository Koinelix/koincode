import { EventEmitter } from "node:events";
import { serialize, deserialize } from "node:v8";

export const WALLET_OWNER_PACKET_MAX = 4 * 1024 * 1024;
const MAX_PORTS = 32, MAX_IDS = 65536, MAX_QUEUED_BYTES = 8 * 1024 * 1024;
export interface WalletOwnerPacketPort {
  assertCurrent(): void;
  readPacket(): Promise<Buffer>;
  writePacket(frame: Buffer): Promise<void>;
  invalidate(): void;
  close(): Promise<void>;
}
type Packet = { version: 1; sequence: number; kind: "message"; data: unknown; ports: number[] }
  | { version: 1; sequence: number; kind: "port_message"; port: number; data: unknown }
  | { version: 1; sequence: number; kind: "port_close"; port: number };
const error = () => new Error("WALLET_OWNER_CHANNEL_UNAVAILABLE");
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= MAX_IDS;
function parse(bytes: Buffer, expected: number): Packet {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > WALLET_OWNER_PACKET_MAX) throw error();
  const decoded: unknown = deserialize(bytes), value: unknown = structuredClone(decoded);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error();
  const row = value as Record<string, unknown>, keys = Object.keys(row).sort().join();
  if (row.version !== 1 || row.sequence !== expected || !id(row.sequence)) throw error();
  if (row.kind === "message" && keys === "data,kind,ports,sequence,version" && Array.isArray(row.ports) && row.ports.length <= MAX_PORTS &&
      row.ports.every(id) && new Set(row.ports).size === row.ports.length) return value as Packet;
  if ((row.kind === "port_message" && keys === "data,kind,port,sequence,version" && id(row.port)) ||
      (row.kind === "port_close" && keys === "kind,port,sequence,version" && id(row.port))) return value as Packet;
  throw error();
}
/** Ordered logical endpoint only, not a source, grant or native identity proof.
 * The original wallet service still owns each connection and its authentication.
 * Nothing from this endpoint enters the protected management material channel. */
export class WalletOwnerLogicalPort extends EventEmitter {
  private started = false;
  private ended = false;
  private readonly queued: unknown[] = [];
  private queuedBytes = 0;
  constructor(readonly id: number, private readonly wire: WalletOwnerProcessChannel) { super(); }
  postMessage(data: unknown): void { if (this.ended) throw error(); this.wire.portMessage(this.id, data); }
  start(): void { this.started = true; for (const data of this.queued.splice(0)) this.emit("message", { data, ports: [] }); this.queuedBytes = 0; }
  deliver(data: unknown): void {
    if (this.ended) throw error();
    if (this.started) { this.emit("message", { data, ports: [] }); return; }
    const size = serialize(data).byteLength;
    if (this.queued.length >= 4 || this.queuedBytes + size > MAX_QUEUED_BYTES) throw error();
    this.queued.push(data); this.queuedBytes += size;
  }
  retire(): void {
    if (this.ended) return; this.ended = true; this.queued.length = this.queuedBytes = 0;
    this.wire.retirePort(this.id); this.emit("close"); this.removeAllListeners();
  }
  close(): void { if (this.ended) return; this.wire.portClose(this.id); this.retire(); }
}
/** Same original message/port semantics over the fixed child's actual pipes.
 * No independent wallet state, business queue or retry exists here. */
export class WalletOwnerProcessChannel extends EventEmitter {
  private readonly ports = new Map<number, WalletOwnerLogicalPort>();
  private readonly used = new Set<number>();
  private nextPort = 1;
  private sequence = 0;
  private incoming = 0;
  private queuedBytes = 0;
  private tail: Promise<void> = Promise.resolve();
  private stopped = false;
  private started = false;
  private closing?: Promise<void>;
  constructor(private readonly transport: WalletOwnerPacketPort, private readonly receivesPorts: boolean) { super(); }
  start(): void { this.current(); if (this.started) throw error(); this.started = true; void this.read(); }
  createPort(): WalletOwnerLogicalPort {
    this.current();
    if (this.receivesPorts || this.ports.size >= MAX_PORTS || this.nextPort > MAX_IDS) throw error();
    const port = new WalletOwnerLogicalPort(this.nextPort++, this); this.ports.set(port.id, port); this.used.add(port.id); return port;
  }
  private current(): void { if (this.stopped) throw error(); this.transport.assertCurrent(); }
  postMessage(data: unknown, ports: readonly WalletOwnerLogicalPort[] = []): void {
    this.current();
    if (this.receivesPorts && ports.length || new Set(ports).size !== ports.length || ports.some((port) => this.ports.get(port.id) !== port)) throw error();
    this.send({ kind: "message", data, ports: ports.map((port) => port.id) });
  }
  portMessage(port: number, data: unknown): void { if (!this.ports.has(port)) throw error(); this.send({ kind: "port_message", port, data }); }
  portClose(port: number): void { if (!this.stopped && this.ports.has(port)) this.send({ kind: "port_close", port }); }
  retirePort(port: number): void { this.ports.delete(port); }
  private send(input: Omit<Extract<Packet, { kind: "message" }>, "version" | "sequence"> | Omit<Extract<Packet, { kind: "port_message" }>, "version" | "sequence"> | Omit<Extract<Packet, { kind: "port_close" }>, "version" | "sequence">): void {
    this.current(); if (this.sequence >= MAX_IDS) throw error();
    const payload = serialize({ ...input, version: 1, sequence: ++this.sequence });
    if (!payload.length || payload.length > WALLET_OWNER_PACKET_MAX || this.queuedBytes + payload.length > MAX_QUEUED_BYTES) { payload.fill(0); void this.close(); throw error(); }
    const frame = Buffer.alloc(payload.length + 4); frame.writeUInt32BE(payload.length); payload.copy(frame, 4); payload.fill(0);
    this.queuedBytes += frame.length;
    const previous = this.tail;
    this.tail = (async () => {
      try { await previous; this.current(); await this.transport.writePacket(frame); this.current(); }
      finally { this.queuedBytes -= frame.length; frame.fill(0); }
    })();
    void this.tail.catch(() => { void this.close().catch(() => {}); });
  }
  private async read(): Promise<void> {
    try {
      while (!this.stopped) {
        this.current(); const bytes = await this.transport.readPacket();
        let packet: Packet;
        try { this.current(); packet = parse(bytes, ++this.incoming); } finally { bytes.fill(0); }
        if (packet.kind === "message") {
          if (!this.receivesPorts && packet.ports.length) throw error();
          const ports = packet.ports.map((id) => {
            if (this.used.has(id) || this.used.size >= MAX_IDS || this.ports.size >= MAX_PORTS) throw error();
            const port = new WalletOwnerLogicalPort(id, this); this.used.add(id); this.ports.set(id, port); return port;
          });
          this.emit("message", { data: packet.data, ports });
        } else {
          const port = this.ports.get(packet.port); if (!port) throw error();
          if (packet.kind === "port_close") port.retire(); else port.deliver(packet.data);
        }
      }
    } catch { await this.close().catch(() => {}); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.closing = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    let failure: unknown;
    try { this.transport.invalidate(); } catch (error) { failure = error; }
    for (const port of [...this.ports.values()]) { try { port.retire(); } catch (error) { failure ??= error; } }
    try { this.emit("close"); } catch (error) { failure ??= error; }
    void (async () => { await this.tail.catch(() => {}); await this.transport.close(); if (failure) throw failure; })().then(resolve, reject);
    return this.closing;
  }
}
