import { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import { RemoteHostError } from "@fcode/shared";
import { waitForWindowsIo } from "./windowsIo.js";
import { windowsRemoteHostNative, type WindowsNativeIo, type WindowsHandle } from "./windowsNative.js";
import type { RemoteHostPrivateListener } from "./privateListener.js";

export interface WindowsPrivatePipeApi {
  createPipe(path: string, first: boolean): WindowsHandle;
  beginIo(handle: WindowsHandle, kind: "connect" | "read" | "write", input?: Buffer): WindowsNativeIo;
  close(handle: WindowsHandle): void;
}
const CHUNK_BYTES = 16 * 1024;

/** Duplex owns a handle and waits for every kernel operation before closing it. */
class WindowsPipeConnection extends Duplex {
  private readonly stopped = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private reading = false;
  constructor(private readonly api: WindowsPrivatePipeApi, private readonly handle: WindowsHandle,
    private readonly fatal: () => never) {
    super({ allowHalfOpen: false, autoDestroy: true, readableHighWaterMark: CHUNK_BYTES, writableHighWaterMark: CHUNK_BYTES });
  }
  private async io(kind: "read" | "write", input?: Buffer): Promise<{ bytes: number; operation: WindowsNativeIo }> {
    this.stopped.signal.throwIfAborted();
    const operation = this.api.beginIo(this.handle, kind, input);
    const wait = waitForWindowsIo(operation, this.stopped.signal, { fatal: this.fatal });
    this.pending.add(wait);
    try { return { bytes: await wait, operation }; }
    finally { this.pending.delete(wait); }
  }
  override _read(): void {
    if (this.reading || this.stopped.signal.aborted) return;
    this.reading = true;
    void this.io("read").then(({ bytes, operation }) => {
      this.reading = false;
      if (!this.destroyed) this.push(bytes ? operation.contents(bytes) : null);
    }).catch((error: unknown) => {
      this.reading = false;
      if (!this.stopped.signal.aborted) this.destroy(error instanceof Error ? error : new Error("Private pipe read failed"));
    });
  }
  override _write(input: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void (async () => {
      let offset = 0;
      while (offset < input.length) {
        const chunk = input.subarray(offset, Math.min(input.length, offset + CHUNK_BYTES));
        const { bytes } = await this.io("write", chunk);
        if (bytes < 1 || bytes > chunk.length) throw new RemoteHostError("connection_failed", "The private pipe write did not progress.", "connection");
        offset += bytes;
      }
    })().then(() => callback(), (error: unknown) => callback(error instanceof Error ? error : new Error("Private pipe write failed")));
  }
  override _final(callback: (error?: Error | null) => void): void {
    this.stopped.abort(); this.push(null); callback();
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.stopped.abort();
    void Promise.allSettled(this.pending).then(() => {
      try { this.api.close(this.handle); callback(error); }
      catch (closeError) { callback(closeError instanceof Error ? closeError : new Error("Private pipe close failed")); }
    });
  }
}

export class WindowsRemoteHostPipeListener implements RemoteHostPrivateListener {
  readonly path = `\\\\.\\pipe\\fcode-remote-${randomBytes(24).toString("hex")}`;
  private readonly stopped = new AbortController();
  private readonly clients = new Set<WindowsPipeConnection>();
  private loop?: Promise<void>;
  private closing?: Promise<void>;
  constructor(private readonly api: WindowsPrivatePipeApi, private readonly accept: (client: Duplex) => void,
    private readonly fatal: () => never = () => process.exit(1)) {}

  start(): void {
    if (this.loop || this.stopped.signal.aborted) throw new Error("The private pipe listener cannot be started again");
    const first = this.api.createPipe(this.path, true);
    let operation: WindowsNativeIo;
    try { operation = this.api.beginIo(first, "connect"); }
    catch (error) { this.api.close(first); throw error; }
    this.loop = this.listen(first, operation).catch(() => { if (!this.stopped.signal.aborted) this.fatal(); });
  }
  private async listen(first: WindowsHandle, firstOperation: WindowsNativeIo): Promise<void> {
    let pending: WindowsHandle | undefined = first;
    let operation = firstOperation;
    try {
      for (;;) {
        await waitForWindowsIo(operation, this.stopped.signal, { fatal: this.fatal });
        if (this.stopped.signal.aborted) break;
        const accepted = pending!;
        if (this.clients.size >= 64) {
          this.api.close(accepted); pending = undefined;
          pending = this.api.createPipe(this.path, false);
          operation = this.api.beginIo(pending, "connect"); continue;
        }
        // Keep a verified listening instance alive before handing the accepted handle to a client.
        pending = this.api.createPipe(this.path, false);
        const client = new WindowsPipeConnection(this.api, accepted, this.fatal);
        this.clients.add(client); client.once("close", () => this.clients.delete(client));
        try { this.accept(client); } catch (error) { client.destroy(); throw error; }
        operation = this.api.beginIo(pending, "connect");
      }
    } finally { if (pending) this.api.close(pending); }
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.stopped.abort();
      const closed = [...this.clients].map((client) => new Promise<void>((resolve) => { client.once("close", resolve); client.destroy(); }));
      await Promise.allSettled([this.loop, ...closed]);
    })();
  }
}

export async function createWindowsRemoteHostListener(accept: (client: Duplex) => void): Promise<RemoteHostPrivateListener> {
  const listener = new WindowsRemoteHostPipeListener(await windowsRemoteHostNative(), accept);
  listener.start(); return listener;
}
