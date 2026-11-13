import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { GeneralControlChannel, GeneralControlError } from "./publicControlChannel.js";
import type { GeneralControlEvent, GeneralControlSnapshot } from "./publicControlProtocol.js";

export const GENERAL_CONTROL_EXECUTABLE = "/Library/KoinCodeProtectedWallet/WalletHost.app/Contents/Helpers/GeneralProtectionBroker.app/Contents/MacOS/GeneralProtectionBroker";
type Child = {
  stdin: Writable; stdout: Readable;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "close", listener: () => void): unknown;
};
type Options = { windowId: string; isCurrent(): boolean; onEvent?(value: GeneralControlEvent): void; onInvalidated?(): void; maximumMs?: number };
const failure = () => new GeneralControlError("GENERAL_CONTROL_UNAVAILABLE");
function validate(options: Options): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.windowId) || typeof options.isCurrent !== "function" ||
    options.maximumMs !== undefined && (!Number.isSafeInteger(options.maximumMs) || options.maximumMs < 1 || options.maximumMs > 30000)) throw failure();
}

/** Sole public child owner. A supplied pipe or snapshot is never native authorization.
 * The ordinary window retains this owner even after a failed or timed-out close. */
export class GeneralControlProcessOwner {
  private readonly channel: GeneralControlChannel;
  private readonly retired: Promise<void>;
  private exitOk = false;
  private reaped = false;
  private ending = false;
  private closing?: Promise<void>;
  private closeFailed = false;
  constructor(private readonly child: Child, private readonly options: Options) {
    validate(options); let retired!: () => void;
    this.retired = new Promise<void>((resolve) => { retired = resolve; });
    child.once("error", () => this.channel.transportFailed());
    child.once("exit", (code, signal) => {
      this.exitOk = code === 0 && signal === null;
      if (!this.channel.closingRequested()) this.channel.transportFailed();
    });
    child.once("close", () => { this.reaped = true; retired(); });
    const end = () => {
      if (this.ending) return; this.ending = true;
      try { child.stdin.end(); } catch { /* Actual pipe/process retirement remains unknown. */ }
    };
    this.channel = new GeneralControlChannel({ ...options, readable: child.stdout, writable: child.stdin, onBroken: end, onDrained: end });
  }
  snapshot(signal?: AbortSignal): Promise<GeneralControlSnapshot> { return this.channel.snapshot(signal); }
  openManager(signal?: AbortSignal): Promise<void> { return this.channel.openManager(signal); }
  snapshotValue(): GeneralControlSnapshot | undefined { return this.channel.snapshotValue(); }
  processReaped(): boolean { return this.reaped; }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    let resolve!: () => void, reject!: (error: GeneralControlError) => void;
    this.closing = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const timer = setTimeout(() => { this.closeFailed = true; reject(new GeneralControlError("GENERAL_OPERATION_TIMEOUT")); }, this.options.maximumMs ?? 30000); timer.unref();
    void (async () => {
      await this.channel.close(); await this.retired;
      if (this.closeFailed || !this.reaped || !this.exitOk || this.channel.failureCode() || !this.channel.isDrained()) throw failure();
    })().then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); this.closeFailed = true; reject(failure()); });
    return this.closing;
  }
}

/** Fixed public launch only. The real broker independently establishes its H1
 * code/profile/namespace/Host facts; this path and control pipe grant no keys. */
export function openGeneralWalletControl(options: Options): GeneralControlProcessOwner {
  validate(options);
  let current = false;
  try { const result: unknown = options.isCurrent(); if (result instanceof Promise) void result.catch(() => {}); current = result === true; } catch { /* No process is launched for a missing public parent. */ }
  if (!current) throw failure();
  const child = spawn(GENERAL_CONTROL_EXECUTABLE, ["--control"], { cwd: "/", env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "ignore"],
    shell: false, windowsHide: true });
  return new GeneralControlProcessOwner(child, options);
}
