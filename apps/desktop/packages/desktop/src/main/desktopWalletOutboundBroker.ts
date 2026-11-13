import { isWalletMessage } from "./desktopWalletProtocol.js";
import {
  isOutboundRequest,
  OUTBOUND_CAPACITY,
  OUTBOUND_OPERATION_TTL_MS,
  outboundId,
  type WalletOutboundRequest,
  type WalletOutboundClient,
} from "./desktopWalletOutboundProtocol.js";

export interface HostPaymentOutboundBinding {
  client: WalletOutboundClient;
  createdBy: { sessionId: string; generation: number };
  managementEpoch: string;
  requestId: string;
  operationId: string;
  walletFrozenDigest: string;
  walletInputDigest: string;
  requestDigest: string;
  url: string;
  method: "GET" | "POST";
  signal: AbortSignal;
  isCurrent(): boolean;
}
type HostGrant = { binding: HostPaymentOutboundBinding; endMono: number; endWall: number;
  abort: () => void; timer: ReturnType<typeof setTimeout> };
const digest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** Main-process presentation correlation only. Executable approvals live in the utility. */
export class DesktopWalletOutboundBroker {
  private readonly notices = new Map<string, WalletOutboundRequest>();
  private readonly hostGrants = new Map<string, HostGrant>();
  private listener?: (request: WalletOutboundRequest) => void;
  private version = 0;
  constructor(
    private readonly send: (body: Record<string, unknown>) => Promise<unknown>,
    private readonly healthy: () => boolean,
    private readonly presenterLost: () => void,
  ) {}
  subscribe(listener: (request: WalletOutboundRequest) => void): () => void {
    if (this.listener) throw new Error("A trusted outbound approval presenter already exists.");
    this.listener = listener;
    return () => {
      if (this.listener !== listener) return;
      this.listener = undefined;
      this.invalidate();
      if (this.healthy()) this.presenterLost();
    };
  }
  hasPending(): boolean { return this.healthy() && this.notices.size > 0; }
  pending(approvalId: string): boolean { return this.healthy() && this.notices.has(approvalId); }

  /** Only a trusted main-process owner may bind an already-approved, frozen host request. */
  bindHostPayment(input: HostPaymentOutboundBinding): () => void {
    if (!input || !input.client || !input.createdBy || !outboundId(input.requestId) || !outboundId(input.operationId) ||
        !outboundId(input.client.clientId) || !input.client.ownerId || input.client.ownerId.length > 256 ||
        !input.client.sessionId || input.client.sessionId.length > 256 ||
        !Number.isSafeInteger(input.client.generation) || input.client.generation < 0 ||
        !input.managementEpoch || input.managementEpoch.length > 256 ||
        !input.createdBy.sessionId || input.createdBy.sessionId.length > 256 ||
        !Number.isSafeInteger(input.createdBy.generation) || input.createdBy.generation < 0 ||
        !["verified", "token_only"].includes(input.client.identityLevel) ||
        !digest(input.walletFrozenDigest) || !digest(input.walletInputDigest) || !digest(input.requestDigest) ||
        typeof input.url !== "string" || input.url.length > 8192 || !["GET", "POST"].includes(input.method) ||
        !(input.signal instanceof AbortSignal) || input.signal.aborted || typeof input.isCurrent !== "function" ||
        !this.healthy() || this.hostGrants.has(input.requestId) || this.hostGrants.size >= OUTBOUND_CAPACITY)
      throw new Error("OUTBOUND_PERMISSION_REQUIRED");
    const binding = { ...input, client: structuredClone(input.client), createdBy: structuredClone(input.createdBy) };
    const grant: HostGrant = { binding, endMono: performance.now() + OUTBOUND_OPERATION_TTL_MS,
      endWall: Date.now() + OUTBOUND_OPERATION_TTL_MS, abort: () => {}, timer: undefined! };
    const release = () => {
      if (this.hostGrants.get(binding.requestId) !== grant) return;
      this.hostGrants.delete(binding.requestId);
      clearTimeout(grant.timer);
      binding.signal.removeEventListener("abort", grant.abort);
      if (this.healthy()) void this.revoke(binding.client.clientId, binding.operationId).catch(() => {});
    };
    grant.abort = release;
    grant.timer = setTimeout(release, OUTBOUND_OPERATION_TTL_MS);
    grant.timer.unref();
    this.hostGrants.set(binding.requestId, grant);
    binding.signal.addEventListener("abort", grant.abort, { once: true });
    if (!this.liveHostGrant(grant)) { release(); throw new Error("OUTBOUND_PERMISSION_REQUIRED"); }
    return release;
  }

  private liveHostGrant(grant: HostGrant): boolean {
    if (!this.healthy() || this.hostGrants.get(grant.binding.requestId) !== grant || grant.binding.signal.aborted ||
        performance.now() >= grant.endMono || Date.now() >= grant.endWall) return false;
    try { return grant.binding.isCurrent() === true; } catch { return false; }
  }

  private matchesHostGrant(notice: WalletOutboundRequest, grant: HostGrant): boolean {
    const b = grant.binding, c = notice.client, x = notice.context;
    return notice.hostPayment === true && x.stage === "before_sign" && x.action === "request" &&
      x.source === "client_operation" && x.parent === null && x.requestId === b.requestId &&
      x.operationId === b.operationId && x.managementEpoch === b.managementEpoch &&
      x.frozenDigest === b.walletFrozenDigest && x.inputDigest === b.walletInputDigest &&
      c.ownerId === b.client.ownerId && c.clientId === b.client.clientId &&
      c.sessionId === b.client.sessionId && c.generation === b.client.generation &&
      c.identityLevel === b.client.identityLevel && x.createdBy.sessionId === b.createdBy.sessionId &&
      x.createdBy.generation === b.createdBy.generation && notice.url === b.url && notice.method === b.method;
  }

  private async allowHost(notice: WalletOutboundRequest, grant: HostGrant): Promise<void> {
    // Do not let a synchronous notification race an already queued revoke or cancellation.
    await Promise.resolve();
    if (!this.liveHostGrant(grant) || !this.matchesHostGrant(notice, grant) ||
        this.notices.get(notice.approvalId) !== notice) { this.deny(notice); return; }
    try {
      const duration = Math.max(1, Math.min(OUTBOUND_OPERATION_TTL_MS,
        grant.endMono - performance.now(), grant.endWall - Date.now()));
      const accepted = await this.send({ type: "outbound-decision", approvalId: notice.approvalId,
        generation: notice.generation, allow: true, durationMs: Math.floor(duration) });
      if (accepted !== true || !this.liveHostGrant(grant) || !this.matchesHostGrant(notice, grant))
        await this.revoke(grant.binding.client.clientId, grant.binding.operationId).catch(() => {});
    } catch { this.deny(notice); }
  }
  receive(value: unknown): boolean {
    if (!isWalletMessage(value)) return false;
    if (value.type === "outbound-closed") {
      if (
        outboundId(value.approvalId) &&
        this.notices.get(value.approvalId)?.generation === value.generation
      )
        this.notices.delete(value.approvalId);
      return true;
    }
    if (value.type !== "outbound-request") return false;
    if (!isOutboundRequest(value)) return true;
    if (value.hostPayment === true || this.hostGrants.has(value.context.requestId)) {
      const grant = this.hostGrants.get(value.context.requestId);
      if (!grant || !this.liveHostGrant(grant) || !this.matchesHostGrant(value, grant) ||
          this.notices.size >= OUTBOUND_CAPACITY || this.notices.has(value.approvalId)) {
        this.deny(value);
        return true;
      }
      const notice = structuredClone(value);
      this.notices.set(notice.approvalId, notice);
      void this.allowHost(notice, grant);
      return true;
    }
    if (!this.healthy() || !this.listener || this.notices.size >= OUTBOUND_CAPACITY) {
      this.deny(value);
      return true;
    }
    if (this.notices.has(value.approvalId)) return true;
    const notice = structuredClone(value);
    this.notices.set(notice.approvalId, notice);
    try {
      const returned: unknown = this.listener(structuredClone(notice));
      if (returned !== undefined) {
        void Promise.resolve(returned).catch(() => {});
        throw new Error("The trusted approval presenter must return synchronously.");
      }
    } catch {
      this.notices.delete(notice.approvalId);
      this.invalidate();
      this.presenterLost();
    }
    return true;
  }
  async inspect(approvalId: string, offset: number): Promise<unknown> {
    const notice = this.notices.get(approvalId),
      version = this.version;
    if (!this.healthy() || !notice) return null;
    const result = await this.send({
      type: "outbound-inspect",
      approvalId,
      generation: notice.generation,
      offset,
    });
    return this.healthy() && this.version === version && this.notices.get(approvalId) === notice
      ? result
      : null;
  }
  async decide(approvalId: string, allow: boolean, durationMs: number): Promise<boolean> {
    // A presenter that throws during notification must not approve through reentrancy.
    await Promise.resolve();
    const notice = this.notices.get(approvalId),
      version = this.version;
    if (!this.healthy() || !notice) return false;
    const result = await this.send({
      type: "outbound-decision",
      approvalId,
      generation: notice.generation,
      allow,
      durationMs,
    });
    return (
      result === true &&
      this.healthy() &&
      this.version === version &&
      (!allow || this.notices.get(approvalId) === notice)
    );
  }
  async revoke(clientId: string, operationId: string): Promise<unknown> {
    if (!this.healthy()) throw new Error("The wallet service is unavailable.");
    return this.send({ type: "outbound-revoke", clientId, operationId });
  }
  invalidate(): void {
    this.version++;
    this.notices.clear();
    for (const grant of this.hostGrants.values()) grant.abort();
  }
  private deny(notice: WalletOutboundRequest): void {
    void this.send({
      type: "outbound-decision",
      approvalId: notice.approvalId,
      generation: notice.generation,
      allow: false,
      durationMs: 1,
    }).catch(() => {});
  }
}
