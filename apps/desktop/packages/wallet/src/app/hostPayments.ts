import { createHash, randomUUID } from "node:crypto";
import { requireWallet, WalletError } from "../domain/errors.js";
import type { FrozenRequest, HostPaymentActivityInput, HostPaymentInput, HostPaymentMaterial, RequestRecord, X402RequestInput } from "../domain/requestModel.js";
import { exactKeys, object } from "../domain/requestValidation.js";
import type { ClientHandle } from "./sessions.js";
import type { RequestStore } from "./requestStore.js";
import type { RequestPayment } from "./requestPayment.js";
import { requestDigest } from "./requestFacts.js";
import { parseQuote } from "./requestQuote.js";
import { operationHistory, ownedOperation } from "./transportState.js";
import { audit } from "./runtimeContext.js";
import { acquireResponseCapacity } from "./responseBudget.js";
import { networkConfig } from "../domain/networks.js";

const digest = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Only authenticated model records can use the additional signing slots. */
export function hostPaymentSigningLimit(record: RequestRecord): number {
  return record.modelPayment ? 10 : 8;
}

/** Only a trusted host may provide this input; it contains no request body or secret. */
export function validateHostPayment(value: unknown): HostPaymentInput {
  const raw = object(value);
  exactKeys(raw, ["url", "method", "requestDigest", "bodySha256", "bodyByteLength", "credentialTag", "paymentRequired", ...(Object.hasOwn(raw, "modelRecovery") ? ["modelRecovery"] : [])]);
  requireWallet(typeof raw.url === "string" && raw.url.length <= 8192, "INVALID_URL", "A bounded canonical payment URL is required.");
  let url: URL;
  try { url = new URL(raw.url as string); } catch { throw new WalletError("INVALID_URL", "The payment URL is invalid."); }
  requireWallet(url.href === raw.url && !url.username && !url.password && !url.hash &&
    !/%(?:2f|5c|25|00)/i.test(url.pathname) &&
    ((url.protocol === "https:" && (!url.port || url.port === "443")) || url.origin === "http://127.0.0.1:8080"),
  "UNSAFE_TARGET", "The payment target is not permitted.");
  requireWallet((raw.method === "GET" || raw.method === "POST") &&
    typeof raw.requestDigest === "string" && digest.test(raw.requestDigest) &&
    (raw.bodySha256 === null || (typeof raw.bodySha256 === "string" && digest.test(raw.bodySha256))) &&
    Number.isSafeInteger(raw.bodyByteLength) && (raw.bodyByteLength as number) >= 0 &&
    (raw.bodyByteLength as number) <= 1024 * 1024 &&
    (raw.bodySha256 !== null || raw.bodyByteLength === 0) &&
    (raw.method !== "GET" || (raw.bodySha256 === null && raw.bodyByteLength === 0)) &&
    (raw.credentialTag === null || (typeof raw.credentialTag === "string" && digest.test(raw.credentialTag))) &&
    typeof raw.paymentRequired === "string" && raw.paymentRequired.length <= 32768,
  "INVALID_REQUEST", "The trusted payment context is invalid.");
  if (raw.modelRecovery !== undefined) {
    const recovery = object(raw.modelRecovery);
    exactKeys(recovery, ["idempotencyKey", "contentType", ...(Object.hasOwn(recovery, "invocationDigest") ? ["invocationDigest"] : [])]);
    requireWallet(recovery.invocationDigest === undefined || typeof recovery.invocationDigest === "string" &&
      digest.test(recovery.invocationDigest), "INVALID_REQUEST", "Invalid model invocation binding.");
    requireWallet(typeof recovery.idempotencyKey === "string" && uuid.test(recovery.idempotencyKey) &&
      (recovery.contentType === null || typeof recovery.contentType === "string" && recovery.contentType.length <= 256 &&
        !/[\r\n\0]/.test(recovery.contentType)), "INVALID_REQUEST", "The model recovery identity is invalid.");
  }
  return structuredClone(raw) as unknown as HostPaymentInput;
}

/** The existing operation journal accepts only a bounded request-shaped commitment. */
export function hostPaymentJournalInput(input: HostPaymentInput, paymentOnly = false): X402RequestInput {
  return { url: input.url, method: input.method, headers: { "x-koincode-host-payment-binding":
    requestDigest(paymentOnly ? { ...input, paymentOnly: true } : input) } };
}

/** This value must be built by the authenticated desktop host, not by a caller script. */
export function validateHostPaymentActivity(value: unknown, sessionId: string): HostPaymentActivityInput {
  const raw = object(value);
  exactKeys(raw, ["version", "workspaceKey", "sessionId", "turnId", "toolCallId", "invocationId", "clientOperationId"]);
  const bounded = (input: unknown, max: number) => typeof input === "string" && input.length > 0 &&
    input.length <= max && !input.includes("\0");
  requireWallet(raw.version === 1 && bounded(raw.workspaceKey, 8192) && bounded(raw.sessionId, 256) &&
    raw.sessionId === sessionId && bounded(raw.turnId, 256) && bounded(raw.toolCallId, 256) &&
    typeof raw.invocationId === "string" && uuid.test(raw.invocationId) &&
    typeof raw.clientOperationId === "string" && uuid.test(raw.clientOperationId),
  "CLIENT_CONTEXT_INVALID", "A bounded host-authenticated activity identity is required.");
  return structuredClone(raw) as unknown as HostPaymentActivityInput;
}

/** Keep recovery binding consistent with the host's stable wallet operation namespace. */
export function hostActivityOperationId(input: HostPaymentActivityInput): string {
  const source = createHash("sha256").update(JSON.stringify(["koincode.wallet-client.v1",
    input.workspaceKey, input.sessionId, input.clientOperationId])).digest("hex");
  return `${source.slice(0, 8)}-${source.slice(8, 12)}-4${source.slice(13, 16)}-8${source.slice(17, 20)}-${source.slice(20, 32)}`;
}

/** Wallet-owned payment state; host-owned business requests never enter this owner. */
export class HostPayments {
  private readonly running = new Set<string>();
  constructor(private readonly store: RequestStore, private readonly payment: RequestPayment,
    private readonly paymentOnly = false) {}

  async prepare(handle: ClientHandle, value: unknown, operationId: string, hostActivity?: unknown): Promise<RequestRecord> {
    const input = validateHostPayment(value);
    requireWallet(uuid.test(operationId), "OPERATION_CONTEXT_REQUIRED", "A durable operation identity is required.");
    requireWallet(this.store.ctx.state.continuityValid(), "OPERATION_HISTORY_INCOMPLETE", "Payment history continuity is unavailable.");
    const context = this.store.ctx.sessions.resolve(handle);
    if (input.modelRecovery) requireWallet(this.paymentOnly && input.credentialTag === null &&
      this.store.ctx.state.snapshot().clients.some(client => client.clientId === context.clientId &&
        client.ownerId === context.ownerId && client.kind === "internal"), "CLIENT_AUTHENTICATION_REQUIRED", "Model recovery requires the internal anonymous host.");
    const binding = hostActivity === undefined ? undefined : validateHostPaymentActivity(hostActivity, context.sessionId);
    if (binding) requireWallet(operationId === hostActivityOperationId(binding) && this.paymentOnly && this.store.ctx.state.snapshot().clients.some(client =>
      client.clientId === context.clientId && client.ownerId === context.ownerId && client.kind === "internal"),
    "CLIENT_AUTHENTICATION_REQUIRED", "Activity identity is restricted to the authenticated internal host.");
    const inputDigest = requestDigest(hostPaymentJournalInput(input, this.paymentOnly));
    const old = ownedOperation(this.store.ctx.state.snapshot(), context, operationId);
    if (old) {
      requireWallet(old.inputDigest === inputDigest, "REQUEST_CONFLICT", "The host operation has different payment input.");
      return old;
    }
    const frozen: FrozenRequest = {
      url: input.url, method: input.method, headers: {}, body: null,
      credentialRef: null, credentialVersion: null, businessKey: null, paymentMode: "policy",
      hostPayment: { ...(input.modelRecovery ? { modelRecovery: input.modelRecovery } : {}), ...(this.paymentOnly ? { paymentOnly: true as const } : {}),
        requestDigest: input.requestDigest, bodySha256: input.bodySha256,
        bodyByteLength: input.bodyByteLength, credentialTag: input.credentialTag },
    };
    const quote = parseQuote(input.paymentRequired, input.url, this.store.env.wall(),
      this.store.env.monotonic(), this.payment.clockId, undefined, this.store.ctx.paymentNetwork);
    requireWallet(!input.modelRecovery || quote.selected.scheme === "upto", "X402_UNSUPPORTED_PAYMENT", "The model channel requires upto payment.");
    const frozenRef = await this.store.putJson(frozen), quoteRef = await this.store.putJson(quote);
    return this.store.ctx.state.mutate((next) => {
      const latest = this.store.ctx.sessions.resolve(handle, next);
      requireWallet(latest.generation === context.generation, "CLIENT_AUTHENTICATION_REQUIRED", "The client generation changed.");
      const history = operationHistory(next, context.clientId);
      const duplicate = history.requests.find((r) => r.ownerId === latest.ownerId && r.clientId === latest.clientId && r.operationId === operationId);
      if (duplicate) {
        requireWallet(duplicate.inputDigest === inputDigest, "REQUEST_CONFLICT", "The host operation has different payment input.");
        return duplicate;
      }
      const now = this.store.env.wall();
      const record: RequestRecord = {
        ...(input.modelRecovery ? { modelPayment: true } : {}),
        requestId: randomUUID(), operationId, ownerId: latest.ownerId, clientId: latest.clientId,
        sessionId: latest.sessionId, generation: latest.generation, epoch: next.managementEpoch,
        inputDigest, frozenRef, frozenDigest: requestDigest(frozen), createdAt: now,
        expiresAt: now + 7 * 86400000, parentRequestId: null, action: "request",
        transportStatus: "awaiting_authorization", paymentStatus: "quoted", httpStatus: 402,
        quoteRef, amountAtomic: quote.selected.amount, network: quote.selected.network,
        ...(binding ? { hostActivity: { ...binding, requestDigest: input.requestDigest, quoteDigest: quote.digest } } : {}),
        intentIds: [], replacementCount: 0, canceled: false,
      };
      history.requests.push(record);
      audit(next, "HOST_PAYMENT_PREPARED", null, { requestId: record.requestId });
      return record;
    });
  }

  /** Recover the same desktop binding when its short-lived routing cache has been discarded. */
  async modelBinding(handle: ClientHandle, operationId: string, invocationDigest: string) {
    const state = this.store.ctx.state.snapshot(), context = this.store.ctx.sessions.resolve(handle, state);
    requireWallet(this.paymentOnly && state.clients.some(client => client.clientId === context.clientId &&
      client.ownerId === context.ownerId && client.kind === "internal"), "CLIENT_AUTHENTICATION_REQUIRED", "An internal host is required.");
    const record = ownedOperation(state, context, operationId);
    requireWallet(record?.modelPayment && record.sessionId === context.sessionId, "PAYMENT_CONTEXT_REQUIRED", "Original model payment not found.");
    const frozen = await this.store.frozen(record), host = frozen.hostPayment;
    requireWallet(host?.paymentOnly && host.modelRecovery?.invocationDigest === invocationDigest,
      "PAYMENT_CONTEXT_CHANGED", "The model invocation changed.");
    const quote = await this.store.quote(record);
    this.store.ctx.sessions.resolve(handle);
    return { paymentId: record.requestId, requestDigest: host.requestDigest, quoteDigest: quote.digest };
  }

  /** Host-only lookup: the caller must authenticate its workspace and chat before invoking this method. */
  async readActivity(handle: ClientHandle, id: string, workspaceKey: string, sessionId: string) {
    requireWallet(this.paymentOnly && typeof id === "string" && uuid.test(id) &&
      typeof workspaceKey === "string" && workspaceKey.length > 0 && workspaceKey.length <= 8192 &&
      typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 256,
    "CLIENT_CONTEXT_INVALID", "A bounded host activity lookup is required.");
    const state = this.store.ctx.state.snapshot(), context = this.store.ctx.sessions.resolve(handle, state);
    requireWallet(context.sessionId === sessionId && state.clients.some(client =>
      client.clientId === context.clientId && client.ownerId === context.ownerId && client.kind === "internal"),
    "CLIENT_AUTHENTICATION_REQUIRED", "The host activity belongs to another session.");
    const record = this.store.owned(handle, id), binding = record.hostActivity;
    requireWallet(record.sessionId === sessionId && binding?.sessionId === sessionId && binding.workspaceKey === workspaceKey,
    "REQUEST_NOT_FOUND", "A protected activity binding is unavailable.");
    let quote: { amountAtomic: string; network: string; asset: string; assetSymbol: string; assetDecimals: number; payTo: string } | undefined;
    try {
      const stored = await this.store.quote(record);
      this.store.ctx.sessions.resolve(handle);
      const config = networkConfig(stored.selected.network);
      if (stored.digest === binding.quoteDigest && stored.selected.asset.toLowerCase() === config.asset.toLowerCase() &&
          requestDigest({ resource: stored.challenge.resource, selected: stored.selected }) === binding.quoteDigest &&
          stored.selected.amount === record.amountAtomic &&
          stored.selected.network === record.network)
        quote = { amountAtomic: stored.selected.amount, network: stored.selected.network, asset: stored.selected.asset,
          assetSymbol: config.assetSymbol, assetDecimals: config.assetDecimals, payTo: stored.selected.payTo };
    } catch { /* Expired or unavailable protected quote must not manufacture an amount. */ }
    let target: string | undefined;
    try {
      const frozen = await this.store.frozen(record);
      if (frozen.hostPayment?.requestDigest === binding.requestDigest) {
        const url = new URL(frozen.url);
        target = url.origin + url.pathname;
      }
    } catch { /* The request tombstone may outlive its protected target. */ }
    this.store.ctx.sessions.resolve(handle);
    const intent = this.store.ctx.state.snapshot().intents.findLast(item => item.requestId === record.requestId && item.clientId === record.clientId);
    return { binding: structuredClone(binding), paymentId: record.requestId, walletOperationId: record.operationId,
      paymentStatus: intent?.status.toLowerCase() ?? record.paymentStatus, transportStatus: record.transportStatus,
      ...(quote ? { quote } : {}), ...(target ? { target } : {}) };
  }

  async submit(handle: ClientHandle, id: string, hostDigest: string, signal: AbortSignal,
    expectedWalletId?: string, expectedQuoteDigest?: string): Promise<HostPaymentMaterial> {
    requireWallet(typeof id === "string" && uuid.test(id) && digest.test(hostDigest), "INVALID_REQUEST", "A bound payment identity is required.");
    const record = this.store.owned(handle, id);
    requireWallet(!this.running.has(id) && this.running.size < hostPaymentSigningLimit(record), "WALLET_BUSY", "The payment is already running or the queue is full.");
    this.running.add(id);
    let started = false;
    try {
      const frozen = await this.store.frozen(record);
      requireWallet((frozen.hostPayment?.paymentOnly === true) === this.paymentOnly,
        "PAYMENT_CONTEXT_CHANGED", "Host execution and independent payment operations cannot be interchanged.");
      requireWallet(frozen.hostPayment?.requestDigest === hostDigest, "PAYMENT_CONTEXT_CHANGED", "The host request digest differs.");
      this.store.assertCurrent(handle, record, frozen);
      await this.store.update(id, (current) => {
        this.store.assertCurrent(handle, current, frozen);
        requireWallet(!signal.aborted && current.httpStatus === 402 &&
          ["awaiting_authorization", "waiting_for_unlock"].includes(current.transportStatus) &&
          !this.store.ctx.state.snapshot().intents.some((intent) => intent.requestId === id && intent.clientId === current.clientId),
        "REQUEST_NOT_RESUMABLE", "A signed or uncertain payment cannot be submitted again.");
        current.transportStatus = "running";
      });
      started = true;
      const reservation = acquireResponseCapacity(this.store.env.blobs, this.paymentOnly ? "payment-material" : undefined);
      try {
        const signed = this.paymentOnly
          ? await this.payment.signPaymentOnly(handle, record, frozen, signal, reservation, expectedWalletId, expectedQuoteDigest)
          : await this.payment.signWithApproval(handle, record, frozen, signal, reservation, undefined, expectedWalletId);
        return { intentId: signed.intentId, paymentHeader: signed.header };
      } finally { reservation.release(); }
    } catch (error) {
      if (!started) throw error;
      const code = error instanceof WalletError ? error.code : "WALLET_PAYMENT_UNKNOWN";
      await this.store.update(id, (record) => {
        const hasIntent = this.store.ctx.state.snapshot().intents.some((intent) => intent.requestId === id && intent.clientId === record.clientId);
        if (hasIntent) { record.transportStatus = "unknown"; record.diagnosticCode = "WALLET_PAYMENT_UNKNOWN"; }
        else if (code === "PAYMENT_APPROVAL_REQUIRED") { record.transportStatus = "awaiting_authorization"; record.paymentStatus = "awaiting_authorization"; }
        else if (code === "WALLET_LOCKED") { record.transportStatus = "waiting_for_unlock"; record.paymentStatus = "quoted"; }
        else if (!record.canceled) { record.transportStatus = "failed"; record.diagnosticCode = code; }
      }).catch(() => {});
      throw error;
    } finally { this.running.delete(id); }
  }
}
