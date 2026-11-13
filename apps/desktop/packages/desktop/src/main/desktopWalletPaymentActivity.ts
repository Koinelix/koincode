import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WalletPaymentActivity } from "@fcode/shared";
import type { DesktopServiceRequestContext } from "./desktopWalletHostTypes.js";
import type { DesktopWalletClientQuote } from "./desktopWalletClientPayments.js";
import { failure } from "./desktopWalletHostIdentity.js";

const MAX_RECORDS = 1000;
const MAX_RECORD_BYTES = 16384;
const ACK_TIMEOUT_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Stored = {
  version: 1;
  activity: WalletPaymentActivity;
  clientOperationId?: string;
  walletOperationId?: string;
  requestDigest?: string;
  quoteDigest?: string;
};
type Pending = { windowId: string; hostId: string; revision: number; resolve(): void; reject(error: Error): void };

/** Main-process owned, redacted projections. Script output never selects the payment. */
export class DesktopWalletPaymentActivity {
  private readonly waiting = new Map<string, Pending>();
  private readonly live = new Map<string, Stored>();
  // Client presentation text is session-memory only and never part of the saved wallet projection.
  private readonly results = new Map<string, NonNullable<WalletPaymentActivity["result"]>>();
  private readonly owners = new Map<string, { hostId: string; windowId: string; identity: string; generation: number }>();
  private readonly refreshing = new Map<string, Promise<WalletPaymentActivity | undefined>>();
  private readonly activeQuotes = new Set<string>();
  constructor(
    private readonly directory: string,
    private readonly send: (
      context: DesktopServiceRequestContext,
      activity: WalletPaymentActivity,
    ) => void,
  ) {}

  private async root(): Promise<string> {
    const dir = resolve(this.directory);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await realpath(dir)) !== dir || (await lstat(dir)).isSymbolicLink())
      throw failure("UNSAFE_STORAGE_PATH");
    return dir;
  }
  private prefix(workspaceKey: string, sessionId: string): string {
    return hash(JSON.stringify([workspaceKey, sessionId]));
  }
  private path(root: string, activity: WalletPaymentActivity): string {
    if (!UUID.test(activity.invocationId)) throw failure("WALLET_ACTIVITY_INVALID");
    return join(
      root,
      `${this.prefix(activity.workspaceKey, activity.sessionId)}-${activity.invocationId}.json`,
    );
  }
  private async save(stored: Stored): Promise<void> {
    const root = await this.root(),
      target = this.path(root, stored.activity);
    const data = JSON.stringify(stored);
    if (Buffer.byteLength(data) > MAX_RECORD_BYTES) throw failure("WALLET_ACTIVITY_INVALID");
    const temp = join(root, `.tmp-${randomUUID()}`);
    const file = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await file.writeFile(data, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
  async list(workspaceKey: string, sessionId: string): Promise<WalletPaymentActivity[]> {
    if (!workspaceKey || workspaceKey.length > 8192 || !sessionId || sessionId.length > 256)
      throw failure("WALLET_ACTIVITY_INVALID");
    const root = await this.root(),
      prefix = `${this.prefix(workspaceKey, sessionId)}-`;
    const names = (await readdir(root)).filter(
      (name) => name.startsWith(prefix) && name.endsWith(".json"),
    );
    if (names.length > MAX_RECORDS) throw failure("WALLET_ACTIVITY_CAPACITY");
    const items: WalletPaymentActivity[] = [];
    for (const name of names) {
      const path = join(root, name),
        info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size > MAX_RECORD_BYTES
      )
        throw failure("WALLET_ACTIVITY_INVALID");
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const current = await file.stat();
        if (current.ino !== info.ino || current.dev !== info.dev || current.size !== info.size)
          throw failure("WALLET_ACTIVITY_INVALID");
        const value: Stored = JSON.parse(await file.readFile("utf8"));
        if (
          value.version !== 1 ||
          value.activity?.version !== 1 ||
          value.activity.workspaceKey !== workspaceKey ||
          value.activity.sessionId !== sessionId ||
          !UUID.test(value.activity.invocationId) ||
          name !== `${prefix}${value.activity.invocationId}.json`
        )
          throw failure("WALLET_ACTIVITY_INVALID");
        const live = this.live.get(value.activity.invocationId);
        if (live && live.activity.workspaceKey === workspaceKey && live.activity.sessionId === sessionId) {
          items.push(live.activity);
        } else {
          const { amountAtomic: _amount, asset: _asset, assetSymbol: _symbol, decimals: _decimals,
            network: _network, payTo: _payTo, paymentId: _payment, target: _target,
            authorizationScope: _authorizationScope, ...identity } = value.activity;
          items.push({ ...identity, status: "unknown" });
        }
      } finally {
        await file.close();
      }
    }
    return items;
  }

  async candidates(workspaceKey: string, sessionId: string): Promise<Array<{ invocationId: string; paymentId: string }>> {
    const root = await this.root(), prefix = `${this.prefix(workspaceKey, sessionId)}-`;
    const names = (await readdir(root)).filter(name => name.startsWith(prefix) && name.endsWith(".json"));
    if (names.length > MAX_RECORDS) throw failure("WALLET_ACTIVITY_CAPACITY");
    const result: Array<{ invocationId: string; paymentId: string }> = [];
    for (const name of names) {
      const path = join(root, name), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_RECORD_BYTES) continue;
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const current = await file.stat();
        if (current.ino !== info.ino || current.dev !== info.dev || current.size !== info.size) continue;
        let value: Stored;
        try { value = JSON.parse(await file.readFile("utf8")) as Stored; }
        catch { continue; }
        if (value.version !== 1 || value.activity?.workspaceKey !== workspaceKey || value.activity.sessionId !== sessionId ||
            !UUID.test(value.activity.invocationId) || name !== `${prefix}${value.activity.invocationId}.json` ||
            typeof value.activity.paymentId !== "string" || !UUID.test(value.activity.paymentId)) continue;
        result.push({ invocationId: value.activity.invocationId, paymentId: value.activity.paymentId });
      } finally { await file.close(); }
    }
    return result;
  }

  listLive(workspaceKey: string, sessionId: string): WalletPaymentActivity[] {
    return [...this.live.values()].map(value => this.display(value.activity)).filter(activity =>
      activity.workspaceKey === workspaceKey && activity.sessionId === sessionId);
  }

  private display(activity: WalletPaymentActivity): WalletPaymentActivity {
    const result = this.results.get(activity.invocationId);
    return result ? { ...activity, result: structuredClone(result) } : activity;
  }

  private checkResult(context: DesktopServiceRequestContext, result: NonNullable<WalletPaymentActivity["result"]>): void {
    const args = context.input.input.args;
    if (!result || result.version !== 1 || !Array.isArray(result.artifacts) || result.artifacts.length > 8 ||
        (result.clientPrompt !== undefined && (typeof result.clientPrompt !== "string" || !result.clientPrompt ||
          Buffer.byteLength(result.clientPrompt, "utf8") > 6000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result.clientPrompt) ||
          !Array.isArray(args) || !args.includes(result.clientPrompt))) ||
        result.artifacts.some(artifact => !artifact || !/^[0-9a-f]{64}$/.test(artifact.artifactId) ||
          typeof artifact.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(artifact.name) ||
          !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > 32 * 1024 * 1024 ||
          (artifact.verifiedMediaType !== undefined && !["image/png", "image/jpeg", "image/webp"].includes(artifact.verifiedMediaType))))
      throw failure("WALLET_ACTIVITY_INVALID");
  }

  async attachResult(context: DesktopServiceRequestContext, quote: Readonly<DesktopWalletClientQuote>,
    invocationId: string, result: NonNullable<WalletPaymentActivity["result"]>): Promise<boolean> {
    if (!context.isCurrent() || context.signal.aborted) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
    this.checkResult(context, result);
    if (!this.hasRecorded(context, quote, invocationId)) return false;
    const stored = this.live.get(invocationId)!;
    stored.activity = { ...stored.activity, revision: stored.activity.revision + 1 };
    await this.save(stored);
    if (!context.isCurrent() || context.signal.aborted) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
    this.results.set(invocationId, structuredClone(result));
    try { this.send(context, this.display(stored.activity)); } catch { /* The in-memory result remains available to this session. */ }
    return true;
  }

  /** Only the original host-owned binding can suppress the generic unknown fallback. */
  hasRecorded(context: DesktopServiceRequestContext, quote: Readonly<DesktopWalletClientQuote>, invocationId: string): boolean {
    const stored = this.live.get(invocationId), activity = stored?.activity, input = context.input.invocation;
    const owner = this.owners.get(invocationId);
    return !!stored && !!owner && owner.hostId === context.scope.hostId && owner.windowId === context.scope.windowId &&
      owner.identity === context.agent.identity && owner.generation === context.agent.generation &&
      stored.version === 1 && activity?.version === 1 &&
      quote.invocationId === invocationId && activity.invocationId === invocationId &&
      activity.workspaceKey === context.agent.workspaceKey && activity.sessionId === input.sessionId &&
      activity.turnId === input.turnId && activity.toolCallId === input.toolCallId &&
      activity.paymentId === quote.paymentId && stored.clientOperationId === quote.clientOperationId &&
      stored.walletOperationId === quote.walletOperationId && stored.requestDigest === quote.requestDigest &&
      stored.quoteDigest === quote.quoteDigest;
  }

  restored(workspaceKey: string, sessionId: string, candidate: { invocationId: string; paymentId: string }, value: unknown): WalletPaymentActivity | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>, binding = record.binding;
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) return;
    const owner = binding as Record<string, unknown>;
    if (owner.version !== 1 || owner.workspaceKey !== workspaceKey || owner.sessionId !== sessionId ||
        owner.invocationId !== candidate.invocationId || record.paymentId !== candidate.paymentId ||
        typeof owner.turnId !== "string" || typeof owner.toolCallId !== "string" ||
        typeof record.paymentStatus !== "string") return;
    const paymentStatus = record.paymentStatus;
    const status = paymentStatus === "confirmed" ? "confirmed" :
      ["signed", "submitted", "observed"].includes(paymentStatus) ? "pending" :
      "unknown";
    const item: WalletPaymentActivity = { version: 1, workspaceKey, sessionId, turnId: owner.turnId,
      toolCallId: owner.toolCallId, invocationId: candidate.invocationId, revision: 1,
      paymentId: candidate.paymentId, status, restored: true };
    const q = record.quote;
    if (q && typeof q === "object" && !Array.isArray(q)) {
      const quote = q as Record<string, unknown>;
      if (typeof quote.amountAtomic === "string" && /^[1-9][0-9]{0,77}$/.test(quote.amountAtomic) &&
          typeof quote.asset === "string" && /^0x[0-9a-f]{40}$/i.test(quote.asset) &&
          typeof quote.assetSymbol === "string" && typeof quote.network === "string" && typeof quote.payTo === "string" &&
          typeof quote.assetDecimals === "number" && Number.isSafeInteger(quote.assetDecimals) && quote.assetDecimals >= 0 && quote.assetDecimals <= 36) {
        Object.assign(item, { amountAtomic: quote.amountAtomic, asset: quote.asset, assetSymbol: quote.assetSymbol,
          network: quote.network, payTo: quote.payTo, decimals: quote.assetDecimals });
      }
    }
    if (typeof record.target === "string") item.target = record.target;
    return item;
  }
  /** Refresh a validated original binding; the wallet ledger remains the financial owner. */
  refresh(workspaceKey: string, sessionId: string, candidate: { invocationId: string; paymentId: string },
    lookup: () => Promise<unknown>): Promise<WalletPaymentActivity | undefined> {
    const key = JSON.stringify([workspaceKey, sessionId, candidate.invocationId, candidate.paymentId]);
    const existing = this.refreshing.get(key);
    if (existing) return existing;
    const before = this.live.get(candidate.invocationId);
    const revision = before?.activity.revision;
    const work = (async () => {
      const value = await lookup();
      const restored = this.restored(workspaceKey, sessionId, candidate, value);
      if (!restored) throw failure("WALLET_ACTIVITY_INVALID");
      const latest = this.live.get(candidate.invocationId);
      if (latest && (latest.activity.workspaceKey !== workspaceKey || latest.activity.sessionId !== sessionId ||
          latest.activity.paymentId !== candidate.paymentId)) throw failure("WALLET_ACTIVITY_INVALID");
      // A runner update made while RPC was pending wins over this older snapshot.
      if (latest?.activity.revision !== revision) return latest ? this.display(latest.activity) : undefined;
      // Cache only a redacted projection, never a second accepted payment or a new authorization.
      const activity = { ...restored, revision: (revision ?? 0) + 1 };
      this.live.set(candidate.invocationId, { ...(latest ?? { version: 1 as const }), activity });
      return this.display(activity);
    })().finally(() => { if (this.refreshing.get(key) === work) this.refreshing.delete(key); });
    this.refreshing.set(key, work);
    return work;
  }
  async quote(
    context: DesktopServiceRequestContext,
    quote: Readonly<DesktopWalletClientQuote>,
    invocationId: string,
  ): Promise<void> {
    if (this.activeQuotes.has(invocationId) || this.live.has(invocationId)) throw failure("WALLET_ACTIVITY_INVALID");
    this.activeQuotes.add(invocationId);
    try {
      if (!context.isCurrent() || context.signal.aborted)
        throw failure("CLIENT_AUTHENTICATION_REQUIRED");
      const activity: WalletPaymentActivity = {
        version: 1,
        workspaceKey: context.agent.workspaceKey,
        sessionId: context.input.invocation.sessionId,
        turnId: context.input.invocation.turnId,
        toolCallId: context.input.invocation.toolCallId,
        invocationId,
        revision: 1,
        paymentId: quote.paymentId,
        amountAtomic: quote.amountAtomic,
        asset: quote.asset,
        assetSymbol: quote.assetSymbol,
        decimals: quote.assetDecimals,
        network: quote.network,
        payTo: quote.payTo,
        authorizationScope: quote.authorizationScope,
        target: quote.url,
        status: "quoted",
      };
      const stored: Stored = {
        version: 1,
        activity,
        clientOperationId: quote.clientOperationId,
        walletOperationId: quote.walletOperationId,
        requestDigest: quote.requestDigest,
        quoteDigest: quote.quoteDigest,
      };
      await this.save(stored);
      this.live.set(invocationId, stored);
      this.owners.set(invocationId, { hostId: context.scope.hostId, windowId: context.scope.windowId,
        identity: context.agent.identity, generation: context.agent.generation });
      try {
        if (!context.isCurrent() || context.signal.aborted || this.waiting.has(invocationId))
          throw failure("CLIENT_AUTHENTICATION_REQUIRED");
        await new Promise<void>((resolvePromise, rejectPromise) => {
          const finish = (error?: Error) => {
            clearTimeout(timer);
            context.signal.removeEventListener("abort", aborted);
            this.waiting.delete(invocationId);
            if (error) rejectPromise(error);
            else resolvePromise();
          };
          const aborted = () => finish(failure("CLIENT_AUTHENTICATION_REQUIRED"));
          const timer = setTimeout(
            () => finish(failure("PAYMENT_QUOTE_DISPLAY_UNAVAILABLE")),
            ACK_TIMEOUT_MS,
          );
          timer.unref();
          this.waiting.set(invocationId, {
            windowId: context.scope.windowId,
            hostId: context.scope.hostId,
            revision: activity.revision,
            resolve: () => finish(),
            reject: finish,
          });
          context.signal.addEventListener("abort", aborted, { once: true });
          try {
            this.send(context, activity);
          } catch {
            finish(failure("PAYMENT_QUOTE_DISPLAY_UNAVAILABLE"));
          }
        });
        if (!context.isCurrent() || context.signal.aborted)
          throw failure("CLIENT_AUTHENTICATION_REQUIRED");
      } catch (error) {
        // An undelivered quote must not remain actionable in the current session.
        // Preserve the original failure even if its redacted projection cannot be saved.
        stored.activity = { ...stored.activity, revision: stored.activity.revision + 1, status: "unknown" };
        try {
          await this.save(stored);
          if (context.isCurrent() && !context.signal.aborted) this.send(context, stored.activity);
        } catch { /* The original quote failure remains authoritative. */ }
        throw error;
      }
    } finally {
      this.activeQuotes.delete(invocationId);
    }
  }
  acknowledge(windowId: string, hostId: string, invocationId: string, revision: number): void {
    const pending = this.waiting.get(invocationId);
    if (!pending || pending.windowId !== windowId || pending.hostId !== hostId || pending.revision !== revision)
      throw failure("WALLET_ACTIVITY_INVALID");
    pending.resolve();
  }

  async closeQuote(context: DesktopServiceRequestContext, quote: Readonly<DesktopWalletClientQuote>,
    invocationId: string, reason: "expired" | "closed"): Promise<void> {
    if (!this.hasRecorded(context, quote, invocationId)) throw failure("WALLET_ACTIVITY_INVALID");
    const stored = this.live.get(invocationId)!;
    if (stored.activity.status !== "quoted") return;
    stored.activity = { ...stored.activity, revision: stored.activity.revision + 1,
      status: "unknown", confirmationState: reason };
    await this.save(stored);
    if (context.isCurrent() && !context.signal.aborted) this.send(context, this.display(stored.activity));
  }

  async unknown(context: DesktopServiceRequestContext, result?: NonNullable<WalletPaymentActivity["result"]>): Promise<void> {
    if (!context.isCurrent() || context.signal.aborted) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
    if (result) this.checkResult(context, result);
    const activity: WalletPaymentActivity = { version: 1, workspaceKey: context.agent.workspaceKey,
      sessionId: context.input.invocation.sessionId, turnId: context.input.invocation.turnId,
      toolCallId: context.input.invocation.toolCallId, invocationId: randomUUID(), revision: 1, status: "unknown" };
    await this.save({ version: 1, activity });
    this.live.set(activity.invocationId, { version: 1, activity });
    if (result) this.results.set(activity.invocationId, structuredClone(result));
    if (context.isCurrent() && !context.signal.aborted) {
      try { this.send(context, this.display(activity)); } catch { /* The saved projection remains available for later recovery. */ }
    }
  }

  async update(
    context: DesktopServiceRequestContext,
    quote: Readonly<DesktopWalletClientQuote>,
    invocationId: string,
    status: WalletPaymentActivity["status"],
  ): Promise<void> {
    if (!context.isCurrent() || context.signal.aborted) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
    const stored = this.live.get(invocationId);
    if (!stored || stored.activity.workspaceKey !== context.agent.workspaceKey ||
        stored.activity.sessionId !== context.input.invocation.sessionId) throw failure("WALLET_ACTIVITY_INVALID");
    if (stored.version !== 1 || stored.activity?.invocationId !== invocationId ||
        stored.activity.paymentId !== quote.paymentId || stored.clientOperationId !== quote.clientOperationId ||
        stored.walletOperationId !== quote.walletOperationId || stored.requestDigest !== quote.requestDigest ||
        stored.quoteDigest !== quote.quoteDigest) throw failure("WALLET_ACTIVITY_INVALID");
    stored.activity = { ...stored.activity, revision: stored.activity.revision + 1, status };
    await this.save(stored);
    if (context.isCurrent() && !context.signal.aborted) {
      try { this.send(context, this.display(stored.activity)); } catch { /* Do not discard an already signed payment. */ }
    }
  }
}
