import { REMOTE_HOST_LIMITS, RemoteHostError, type RemoteSshConnection } from "@fcode/shared";

export interface RemotePhysicalLease { connection: RemoteSshConnection; redactionValues: string[]; release(): void }
interface Borrower { check(): void }
interface PoolEntry {
  key: string; hostId: string; clientId: string; sessionId: string;
  borrowers: Set<Borrower>; controller: AbortController; removed: boolean;
  ready: Promise<RemotePhysicalLease>; physical?: RemotePhysicalLease; detach?: () => void;
  timer?: ReturnType<typeof setTimeout>; lastUsed: number;
}

/** Owns physical connections only; every borrower retains its own authorization and cancellation. */
export class RemoteSessionConnectionPool {
  private readonly entries = new Map<string, PoolEntry>();
  private closed = false;
  constructor(private readonly options: { idleMs?: number; maxConnections?: number } = {}) {}

  async acquire(input: { key: string; hostId: string; clientId: string; sessionId: string; check(): void; signal?: AbortSignal;
    connect(check: () => void, signal: AbortSignal): Promise<RemotePhysicalLease> }): Promise<{ connection: RemoteSshConnection; release(): void }> {
    if (this.closed) throw new RemoteHostError("canceled", "The SSH connection pool is closed.");
    input.signal?.throwIfAborted(); input.check();
    let entry = this.entries.get(input.key);
    if (entry?.physical && entry.physical.connection.isAlive?.() === false) { this.remove(entry); entry = undefined; }
    let fresh = false;
    if (!entry) {
      this.reserve(); fresh = true;
      entry = { key: input.key, hostId: input.hostId, clientId: input.clientId, sessionId: input.sessionId,
        borrowers: new Set(), controller: new AbortController(), removed: false, lastUsed: Date.now(), ready: Promise.resolve(undefined!) };
      this.entries.set(input.key, entry);
    }
    const captured = entry;
    const borrower = { check: input.check };
    captured.borrowers.add(borrower); clearTimeout(captured.timer); captured.timer = undefined;
    let released = false;
    const release = () => {
      if (released) return; released = true;
      captured.borrowers.delete(borrower); captured.lastUsed = Date.now();
      if (captured.removed || captured.borrowers.size) return;
      // Unknown transport lifecycles remain one-shot rather than reusing an unverifiable socket.
      if (!captured.physical || !captured.physical.connection.isAlive || !captured.physical.connection.onClose) this.remove(captured);
      else {
        captured.timer = setTimeout(() => { if (!captured.borrowers.size) this.remove(captured); }, this.options.idleMs ?? REMOTE_HOST_LIMITS.connectionIdleMs);
        captured.timer.unref();
      }
    };
    if (fresh) {
      captured.ready = Promise.resolve().then(() => input.connect(() => this.assertAuthorized(captured), captured.controller.signal)).then((physical) => {
        if (captured.removed) { physical.release(); throw new RemoteHostError("canceled", "The SSH connection was superseded."); }
        captured.physical = physical;
        const detach = physical.connection.onClose?.(() => this.remove(captured));
        if (captured.removed) detach?.(); else captured.detach = detach;
        if (physical.connection.isAlive?.() === false) throw new RemoteHostError("connection_failed", "The SSH connection closed before it could be borrowed.");
        return physical;
      }).catch((error) => { this.remove(captured); throw error; });
      void captured.ready.catch(() => {});
    }
    try {
      const physical = await waitForConnection(captured.ready, input.signal);
      input.signal?.throwIfAborted(); input.check();
      if (captured.removed) throw new RemoteHostError("connection_failed", "The borrowed SSH connection is no longer available.");
      return { connection: physical.connection, release };
    } catch (error) { release(); throw error; }
  }

  revokeHost(hostId: string): void { this.revoke((entry) => entry.hostId === hostId); }
  revokeClient(clientId: string): void { this.revoke((entry) => entry.clientId === clientId); }
  revokeSession(clientId: string, sessionId: string): void { this.revoke((entry) => entry.clientId === clientId && entry.sessionId === sessionId); }
  dispose(): void { this.closed = true; this.revoke(() => true); }
  get snapshot(): { connections: number; borrowed: number } {
    return { connections: this.entries.size, borrowed: [...this.entries.values()].reduce((sum, entry) => sum + entry.borrowers.size, 0) };
  }

  private reserve(): void {
    if (this.entries.size < (this.options.maxConnections ?? REMOTE_HOST_LIMITS.connectionCount)) return;
    const idle = [...this.entries.values()].filter((entry) => !entry.borrowers.size).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!idle) throw new RemoteHostError("storage_busy", "All cached SSH connections are in use.", "connection");
    this.remove(idle);
  }
  private assertAuthorized(entry: PoolEntry): void {
    if (entry.removed) throw new RemoteHostError("canceled", "The SSH connection reservation was revoked.");
    for (const borrower of entry.borrowers) { try { borrower.check(); return; } catch { /* Another live borrower can still own the handshake. */ } }
    throw new RemoteHostError("permission_denied", "No authorized caller owns this SSH handshake.", "authorization");
  }
  private revoke(matches: (entry: PoolEntry) => boolean): void {
    for (const entry of this.entries.values()) if (matches(entry)) this.remove(entry);
  }
  private remove(entry: PoolEntry): void {
    if (entry.removed) return; entry.removed = true;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    clearTimeout(entry.timer); entry.detach?.(); entry.controller.abort(); entry.physical?.release();
  }
}

function waitForConnection<T>(ready: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return ready;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void ready.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
