import { createHash, randomUUID } from "node:crypto";
import type { DesktopServiceRequestContext } from "./desktopWalletHostTypes.js";
import { failure } from "./desktopWalletHostIdentity.js";
import { walletClientPaymentLimitSchema, type WalletClientPaymentLimit } from "@fcode/shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;

export interface DesktopWalletClientQuote {
  invocationId: string;
  clientOperationId: string;
  walletOperationId: string;
  paymentId: string;
  requestDigest: string;
  quoteDigest: string;
  amountAtomic: string;
  asset: string;
  assetSymbol: string;
  assetDecimals: number;
  authorizationScope: "once" | "session" | "persistent" | "none";
  network: string;
  payTo: string;
  url: string;
  method: "GET" | "POST";
}

/** A scoped proxy for the same payment-only protocol used by authenticated external clients. */
export class DesktopWalletClientPayments {
  private connection?: Awaited<ReturnType<DesktopServiceRequestContext["connectWallet"]>>;
  private connecting?: ReturnType<DesktopServiceRequestContext["connectWallet"]>;
  private readonly prepared = new Map<string, DesktopWalletClientQuote>();
  private closed = false;
  private readonly paymentLimit?: Readonly<WalletClientPaymentLimit>;
  constructor(private readonly context: DesktopServiceRequestContext,
    private readonly beforeSign: () => Promise<void> = async () => {},
    private readonly onQuote?: (quote: Readonly<DesktopWalletClientQuote>) => Promise<void>,
    private readonly withCredentialLease: <T>(action: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) => Promise<T> =
      (action, signal) => action(signal),
    paymentLimit?: WalletClientPaymentLimit) {
    if (paymentLimit !== undefined) {
      const parsed = walletClientPaymentLimitSchema.safeParse(paymentLimit);
      if (!parsed.success) throw failure("WALLET_CLIENT_INPUT_INVALID");
      this.paymentLimit = Object.freeze(parsed.data);
    }
  }

  ownsPayment(paymentId: string, clientOperationId: string): boolean {
    return this.prepared.get(paymentId)?.clientOperationId === clientOperationId;
  }

  async lookupPayment(paymentId: string, clientOperationId: string): Promise<{
    quote: Readonly<DesktopWalletClientQuote>; paymentStatus: string; transportStatus: string;
  }> {
    this.assertCurrent();
    const quote = this.prepared.get(paymentId);
    if (!quote || quote.clientOperationId !== clientOperationId || !this.connection)
      throw failure("PAYMENT_CONTEXT_REQUIRED");
    const view = await this.connection.client.callPaymentClient("get_payment", { paymentId }, this.context.signal) as {
      requestId?: unknown; operationId?: unknown; paymentStatus?: unknown; transportStatus?: unknown };
    this.assertCurrent();
    if (!view || view.requestId !== paymentId || view.operationId !== quote.walletOperationId ||
        typeof view.paymentStatus !== "string" || !/^[a-z_]{1,40}$/.test(view.paymentStatus) ||
        typeof view.transportStatus !== "string" || !/^[a-z_]{1,40}$/.test(view.transportStatus))
      throw failure("WALLET_CLIENT_PROTOCOL_INVALID");
    return { quote, paymentStatus: view.paymentStatus, transportStatus: view.transportStatus };
  }

  private assertCurrent() {
    if (this.closed || this.context.signal.aborted || !this.context.isCurrent() ||
        (this.connection && !this.connection.isCurrent())) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
  }
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.assertCurrent();
    if (!["capabilities", "prepare_payment", "authorize_payment", "get_payment", "reconcile_payment", "cancel_payment"].includes(method))
      throw failure("METHOD_NOT_FOUND");
    this.connecting ??= this.context.connectWallet();
    this.connection ??= await this.connecting;
    this.assertCurrent();
    const client = this.connection.client, signal = this.context.signal;
    if (method === "prepare_payment") {
      if (Object.keys(params).sort().join(",") !== "operationId,payment" || typeof params.operationId !== "string" ||
          !UUID.test(params.operationId) || !params.payment || typeof params.payment !== "object" || Array.isArray(params.payment) ||
          typeof (params.payment as Record<string, unknown>).requestDigest !== "string" ||
          !digest.test((params.payment as Record<string, unknown>).requestDigest as string) || this.prepared.size >= 8)
        throw failure("INVALID_REQUEST");
      const source = createHash("sha256").update(JSON.stringify(["koincode.wallet-client.v1",
        this.context.agent.workspaceKey, this.context.input.invocation.sessionId, params.operationId])).digest("hex");
      const operationId = `${source.slice(0,8)}-${source.slice(8,12)}-4${source.slice(13,16)}-8${source.slice(17,20)}-${source.slice(20,32)}`;
      const hostActivity = { version: 1, workspaceKey: this.context.agent.workspaceKey,
        sessionId: this.context.input.invocation.sessionId, turnId: this.context.input.invocation.turnId,
        toolCallId: this.context.input.invocation.toolCallId, invocationId: randomUUID(), clientOperationId: params.operationId };
      const view = await client.callPaymentClient(method, { ...params, operationId, hostActivity }, signal) as {
        paymentId: string; operationId: string; quote?: Record<string, unknown>; hostActivity?: Record<string, unknown> };
      this.assertCurrent();
      const input = params.payment as Record<string, unknown>, q = view?.quote;
      if (!view || typeof view.paymentId !== "string" || !UUID.test(view.paymentId) || view.operationId !== operationId ||
          !view.hostActivity || Object.entries(hostActivity).some(([key, value]) => view.hostActivity![key] !== value) ||
          !q || typeof q.digest !== "string" || !digest.test(q.digest) || typeof q.amountAtomic !== "string" ||
          view.hostActivity.requestDigest !== input.requestDigest || view.hostActivity.quoteDigest !== q.digest ||
          !/^[1-9][0-9]{0,77}$/.test(q.amountAtomic) || typeof q.asset !== "string" || !/^0x[0-9a-f]{40}$/i.test(q.asset) ||
          typeof q.payTo !== "string" || !/^0x[0-9a-f]{40}$/i.test(q.payTo) ||
          typeof q.assetSymbol !== "string" || !/^[A-Za-z0-9]{1,16}$/.test(q.assetSymbol) ||
          !Number.isInteger(q.assetDecimals) || (q.assetDecimals as number) < 0 || (q.assetDecimals as number) > 36 ||
          !["once", "session", "persistent", "none"].includes(q.authorizationScope as string) ||
          typeof q.network !== "string" || q.network.length > 100 || typeof input.url !== "string" ||
          (input.method !== "GET" && input.method !== "POST")) throw failure("WALLET_CLIENT_PROTOCOL_INVALID");
      let target: URL;
      try { target = new URL(input.url); }
      catch { throw failure("WALLET_CLIENT_PROTOCOL_INVALID"); }
      this.prepared.set(view.paymentId, Object.freeze({ invocationId: hostActivity.invocationId, clientOperationId: params.operationId, walletOperationId: operationId,
        paymentId: view.paymentId, requestDigest: input.requestDigest as string, quoteDigest: q.digest,
        amountAtomic: q.amountAtomic, asset: q.asset, assetSymbol: q.assetSymbol, assetDecimals: q.assetDecimals as number, network: q.network,
        authorizationScope: q.authorizationScope as DesktopWalletClientQuote["authorizationScope"],
        payTo: q.payTo, url: target.origin + target.pathname, method: input.method }));
      return view;
    }
    if (method === "authorize_payment") {
      if (Object.keys(params).join(",") !== "paymentId" || typeof params.paymentId !== "string") throw failure("INVALID_REQUEST");
      const quote = this.prepared.get(params.paymentId);
      if (!quote) throw failure("PAYMENT_CONTEXT_REQUIRED");
      if (this.paymentLimit) {
        if (quote.network !== this.paymentLimit.network || quote.asset.toLowerCase() !== this.paymentLimit.asset.toLowerCase())
          throw failure("PAYMENT_LIMIT_SCOPE_MISMATCH");
        if (BigInt(quote.amountAtomic) > BigInt(this.paymentLimit.maxAmountAtomic)) throw failure("PAYMENT_LIMIT_EXCEEDED");
      }
      await this.beforeSign();
      this.assertCurrent();
      if (!this.onQuote) throw failure("PAYMENT_QUOTE_DISPLAY_UNAVAILABLE");
      await this.onQuote(quote);
      this.assertCurrent();
      return this.withCredentialLease(async leaseSignal => {
        this.assertCurrent();
        let material: unknown, callError: unknown, failed = false;
        try {
          material = await client.callPaymentClient(method, { paymentId: params.paymentId,
            requestDigest: quote.requestDigest, quoteDigest: quote.quoteDigest }, leaseSignal);
        } catch (error) { failed = true; callError = error; }
        try { await client.drain(); }
        catch {
          if (!this.connection?.drainAfterDisconnect) throw failure("WALLET_DRAIN_UNCERTAIN");
          try { await this.connection.drainAfterDisconnect(); }
          catch { throw failure("WALLET_DRAIN_UNCERTAIN"); }
        }
        this.assertCurrent();
        if (failed) throw callError;
        return material;
      }, signal);
    }
    return client.callPaymentClient(method, params, signal);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.connection) await this.connection.client.drain();
  }
}
