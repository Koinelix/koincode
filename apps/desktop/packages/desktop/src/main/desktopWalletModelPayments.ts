import { createHash } from "node:crypto";
import type { WalletHostModelCall } from "@fcode/shared";
import type { Channel } from "./desktopWalletHostTypes.js";
import { failure } from "./desktopWalletHostIdentity.js";

export interface DesktopModelPaymentContext {
  input: WalletHostModelCall;
  workspaceKey: string;
  signal: AbortSignal;
  isCurrent(): boolean;
  connect(): Promise<Channel>;
}
type Prepared = { paymentId: string; requestDigest: string; quoteDigest: string; invocation: string };
const uuid = /^[0-9a-f-]{36}$/i;
const digest = /^[0-9a-f]{64}$/;

/** These wallet errors are final replies for this call, even with other admissions pending. */
export function isFinalModelPaymentError(method: WalletHostModelCall["method"], code: string): boolean {
  if (code === "MODEL_QUOTE_INCREASED") return method === "prepare_payment";
  if (code === "PAYMENT_WAIVER_BROKEN")
    return method === "acquire_payment" || method === "prepare_payment" || method === "authorize_payment";
  return method === "acquire_payment" && ["PAYMENT_QUEUE_TIMEOUT", "PAYMENT_CONTEXT_CHANGED",
    "PAYMENT_QUEUE_FULL", "CLIENT_AUTHENTICATION_REQUIRED"].includes(code);
}

/** Main associates model attempts with wallet operations, without creating a tool capability. */
export class DesktopWalletModelPayments {
  private readonly prepared = new Map<string, Prepared>();
  async call(context: DesktopModelPaymentContext): Promise<unknown> {
    const { input, signal } = context;
    const current = () => {
      if (signal.aborted || !context.isCurrent()) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
    };
    current();
    const source = createHash("sha256").update(JSON.stringify(["koincode.model-payment.v1",
      context.workspaceKey, input.invocation.sessionId, input.operationId])).digest("hex");
    const operationId = `${source.slice(0,8)}-${source.slice(8,12)}-4${source.slice(13,16)}-8${source.slice(17,20)}-${source.slice(20,32)}`;
    const { traceId, spanId, sessionId, turnId, modelRequestId, runtimeScope } = input.invocation;
    const invocation = createHash("sha256").update(JSON.stringify([traceId, spanId, sessionId, turnId, modelRequestId, runtimeScope])).digest("hex");
    let existing = this.prepared.get(operationId);
    if (existing && existing.invocation !== invocation) throw failure("PAYMENT_CONTEXT_CHANGED");
    const client = await context.connect();
    current();
    if (input.method === "acquire_payment") {
      if (Object.keys(input.input).join(",") !== "payment") throw failure("INVALID_REQUEST");
      return client.callPaymentClient("acquire_model_admission", { operationId, payment: input.input.payment, invocationDigest: invocation }, signal);
    }
    if (input.method === "release_payment" || input.method === "payment_wait_status") {
      if (Object.keys(input.input).length) throw failure("INVALID_REQUEST");
      return client.callPaymentClient(input.method === "payment_wait_status" ? "model_admission_status" : "release_model_admission",
        { operationId, invocationDigest: invocation }, signal);
    }
    if (input.method === "prepare_payment") {
      if (Object.keys(input.input).sort().join(",") !== "contentType,idempotencyKey,payment" || !input.input.payment ||
          typeof input.input.payment !== "object" || Array.isArray(input.input.payment)) throw failure("INVALID_REQUEST");
      const payment = input.input.payment as Record<string, unknown>;
      if (typeof payment.requestDigest !== "string" || !digest.test(payment.requestDigest)) throw failure("INVALID_REQUEST");
      const result = await client.callPaymentClient("prepare_payment", { operationId, payment: { ...payment,
        modelRecovery: { idempotencyKey: input.input.idempotencyKey, contentType: input.input.contentType, invocationDigest: invocation } } }, signal) as {
        paymentId: string; operationId: string; quote?: { digest?: string } };
      current();
      if (!result || !uuid.test(result.paymentId) || result.operationId !== operationId ||
          !result.quote?.digest || !digest.test(result.quote.digest)) throw failure("WALLET_CLIENT_PROTOCOL_INVALID");
      // The protected wallet record remains authoritative even if Main loses a completion or restarts.
      if (!this.prepared.has(operationId) && this.prepared.size >= 32) this.prepared.delete(this.prepared.keys().next().value!);
      this.prepared.set(operationId, { paymentId: result.paymentId, requestDigest: payment.requestDigest,
        quoteDigest: result.quote.digest, invocation });
      return result;
    }
    if (!existing) {
      const binding = await client.callPaymentClient("read_model_binding", { operationId, invocationDigest: invocation }, signal) as Omit<Prepared, "invocation">;
      current();
      if (!binding || !uuid.test(binding.paymentId) || !digest.test(binding.requestDigest) || !digest.test(binding.quoteDigest))
        throw failure("WALLET_CLIENT_PROTOCOL_INVALID");
      existing = { ...binding, invocation };
    }
    if (input.method === "authorize_payment") {
      if (Object.keys(input.input).length) throw failure("INVALID_REQUEST");
      const material = await client.callPaymentClient("authorize_payment", { paymentId: existing.paymentId,
        requestDigest: existing.requestDigest, quoteDigest: existing.quoteDigest }, signal);
      // A successful reply completes this call. Channel-wide drain would wait on other
      // admissions that need this signature to be sent and settled before they can proceed.
      current();
      return material;
    }
    if (input.method === "complete_payment") {
      if (Object.keys(input.input).length) throw failure("INVALID_REQUEST");
      const result = await client.callPaymentClient("complete_model_payment", { paymentId: existing.paymentId }, signal);
      this.prepared.delete(operationId);
      return result;
    }
    if (Object.keys(input.input).some(key => key !== "transactionHash") ||
        (input.method !== "reconcile_payment" && Object.keys(input.input).length)) throw failure("INVALID_REQUEST");
    return client.callPaymentClient(input.method, { ...input.input, paymentId: existing.paymentId }, signal);
  }
}
