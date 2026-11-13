import { randomUUID } from "node:crypto";
import {
  OUTBOUND_CAPACITY,
  OUTBOUND_PAGE_UNITS,
  OUTBOUND_TEXT_UNITS,
  OUTBOUND_TTL_MS,
  OUTBOUND_OPERATION_TTL_MS,
  isOutboundRequest,
  outboundBinding,
  outboundId,
  type WalletRequestOptions,
  type WalletOutboundRequest,
} from "../main/desktopWalletOutboundProtocol.js";
import { isWalletMessage } from "../main/desktopWalletProtocol.js";

interface Entry {
  notice: WalletOutboundRequest;
  binding: string;
  text: string;
  monoEnd: number;
  wallEnd: number;
  approved: boolean;
  createdMono: number;
  createdWall: number;
  resolve?: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort: () => void;
}

/** Only this utility-local owner holds executable outbound approvals. */
export class WalletOutboundApprovals {
  private generation = randomUUID();
  private readonly entries = new Map<string, Entry>();
  private readonly bindings = new Map<string, string>();
  private lastMono: number;
  private lastWall: number;
  private disposed = false;
  constructor(
    private readonly post: (message: unknown) => void,
    private readonly monotonic = () => performance.now(),
    private readonly wall = Date.now,
  ) {
    this.lastMono = monotonic();
    this.lastWall = wall();
  }

  readonly authorize: WalletRequestOptions["authorize"] = (
    frozen,
    client,
    _phase,
    signal,
    context,
  ) => {
    if (!this.checkClock() || this.disposed || signal?.aborted) return Promise.resolve(false);
    const binding = outboundBinding(client, context);
    const previous = this.bindings.get(binding);
    const text = JSON.stringify(frozen);
    if (previous) {
      const entry = this.live(previous, this.generation);
      if (entry?.approved && entry.text === text) return Promise.resolve(true);
    }
    if (previous) this.remove(previous);
    if (this.entries.size >= OUTBOUND_CAPACITY) return Promise.resolve(false);
    if (text.length > OUTBOUND_TEXT_UNITS) return Promise.resolve(false);
    const approvalId = randomUUID();
    const notice: WalletOutboundRequest = {
      type: "outbound-request",
      approvalId,
      generation: this.generation,
      client: structuredClone(client),
      context: structuredClone(context),
      url: frozen.url,
      method: frozen.method,
      bodyBytes: Buffer.byteLength(frozen.body ?? ""),
      inspectionUnits: text.length,
      ...(frozen.hostPayment ? { hostPayment: true } : {}),
    };
    if (!isOutboundRequest(notice)) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const entry: Entry = {
        notice,
        binding,
        text,
        monoEnd: this.lastMono + OUTBOUND_TTL_MS,
        wallEnd: this.lastWall + OUTBOUND_TTL_MS,
        approved: false,
        createdMono: this.lastMono,
        createdWall: this.lastWall,
        resolve,
        timer: setTimeout(() => this.remove(approvalId), OUTBOUND_TTL_MS),
        signal,
        abort: () => this.remove(approvalId),
      };
      entry.timer.unref();
      this.entries.set(approvalId, entry);
      this.bindings.set(binding, approvalId);
      signal?.addEventListener("abort", entry.abort, { once: true });
      try {
        this.post(structuredClone(notice));
      } catch {
        this.remove(approvalId);
      }
    });
  };

  readonly checkOutbound: WalletRequestOptions["checkOutbound"] = (client, context) => {
    if (!this.checkClock()) return false;
    const id = this.bindings.get(outboundBinding(client, context));
    const entry = id ? this.live(id, this.generation) : undefined;
    return !this.disposed && entry?.approved === true;
  };

  decide(value: unknown): boolean {
    if (
      !isWalletMessage(value) ||
      !outboundId(value.approvalId) ||
      !outboundId(value.generation) ||
      typeof value.allow !== "boolean" ||
      typeof value.durationMs !== "number" ||
      !Number.isSafeInteger(value.durationMs) ||
      value.durationMs < 1 ||
      value.durationMs > OUTBOUND_OPERATION_TTL_MS
    )
      return false;
    const entry = this.live(value.approvalId, value.generation);
    if (!entry || entry.approved) return false;
    if (!value.allow) {
      this.remove(value.approvalId);
      return true;
    }
    entry.approved = true;
    entry.monoEnd = Math.min(entry.createdMono + OUTBOUND_OPERATION_TTL_MS, this.lastMono + value.durationMs);
    entry.wallEnd = Math.min(entry.createdWall + OUTBOUND_OPERATION_TTL_MS, this.lastWall + value.durationMs);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => this.remove(entry.notice.approvalId),
      Math.max(1, entry.monoEnd - this.lastMono),
    );
    entry.timer.unref();
    entry.resolve?.(true);
    entry.resolve = undefined;
    return true;
  }

  inspect(approvalId: string, generation: string, offset: number) {
    const entry = this.live(approvalId, generation);
    if (!entry || !Number.isSafeInteger(offset) || offset < 0 || offset > entry.text.length)
      return null;
    const text = entry.text.slice(offset, offset + OUTBOUND_PAGE_UNITS);
    return { offset, text, nextOffset: offset + text.length, totalUnits: entry.text.length };
  }

  revoke(clientId: string, operationId: string): void {
    for (const [id, entry] of this.entries)
      if (
        entry.notice.client.clientId === clientId &&
        entry.notice.context.operationId === operationId
      )
        this.remove(id);
  }
  invalidate(): void {
    this.generation = randomUUID();
    // Snapshot the old generation before close notifications can reenter the owner.
    const ids = Array.from(this.entries.keys());
    for (const id of ids) this.remove(id);
  }
  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  private live(id: string, generation: string): Entry | undefined {
    if (!this.checkClock()) return undefined;
    const entry = this.entries.get(id);
    if (!entry || generation !== this.generation || generation !== entry.notice.generation)
      return undefined;
    if (this.lastMono >= entry.monoEnd || this.lastWall >= entry.wallEnd || entry.signal?.aborted) {
      this.remove(id);
      return undefined;
    }
    return entry;
  }
  private checkClock(): boolean {
    const mono = this.monotonic(),
      wall = this.wall();
    const valid =
      Number.isFinite(mono) &&
      Number.isFinite(wall) &&
      mono >= this.lastMono &&
      wall >= this.lastWall &&
      Math.abs(mono - this.lastMono - (wall - this.lastWall)) <= 2000;
    if (!valid) this.invalidate();
    if (Number.isFinite(mono) && Number.isFinite(wall)) {
      this.lastMono = mono;
      this.lastWall = wall;
    }
    return valid;
  }
  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (this.bindings.get(entry.binding) === id) this.bindings.delete(entry.binding);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.abort);
    entry.text = "";
    entry.resolve?.(false);
    try {
      this.post({ type: "outbound-closed", approvalId: id, generation: entry.notice.generation });
    } catch {
      /* A closed parent port cannot keep an approval alive. */
    }
  }
}
