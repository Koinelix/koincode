import { paymentStage } from "../app/paymentTiming.js";
import type { WalletRuntime } from "../app/runtime.js";
import type { WalletRequests } from "../app/requests.js";
import type { ClientHandle } from "../app/sessions.js";
import { HostPayments, hostPaymentSigningLimit } from "../app/hostPayments.js";
import { abortable } from "../app/requestWait.js";
import { requireWallet, WalletError } from "../domain/errors.js";
import type { HostPaymentInput } from "../domain/requestModel.js";
import type { PaymentApprovalChoice, PaymentApprovalView } from "../app/paymentApprovalTypes.js";
import { networkConfig } from "../domain/networks.js";
import { requestDeadline } from "../app/requestDeadline.js";
import { REQUEST_PREPARATION_TIMEOUT_MS } from "../domain/requestTiming.js";
import { checkGrant } from "../domain/grants.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;

/** Public payment-only SDK. A handle must come from existing wallet client authentication. */
export function createAuthenticatedPaymentClient(options: {
  runtime: WalletRuntime;
  requests: WalletRequests;
  handle: ClientHandle;
  scopeToSession?: boolean;
  present?: (view: PaymentApprovalView, decide: (choice: PaymentApprovalChoice) => Promise<unknown>, signal: AbortSignal) => Promise<void>;
}) {
  const { runtime, requests, handle } = options;
  const payments = new HostPayments(requests.store, requests.payment, true);
  const confirming = new Set<string>();
  const active = new Map<string, AbortController>();
  const assertCurrent = (signal: AbortSignal) => {
    signal.throwIfAborted(); runtime.sessions.resolve(handle);
  };
  return {
    async call(method: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
      assertCurrent(signal);
      if (method === "capabilities") {
        requireWallet(Object.keys(input).length === 0, "INVALID_REQUEST", "Capabilities accept no arguments.");
        return { protocolVersion: 1, paymentOnly: true, networks: [runtime.paymentNetwork],
          methods: ["capabilities", "prepare_payment", "authorize_payment", "get_payment", "reconcile_payment", "cancel_payment"] };
      }
      if (method === "acquire_model_admission" || method === "release_model_admission" || method === "model_admission_status") {
        const invocation = input.invocationDigest;
        requireWallet(invocation === undefined || typeof invocation === "string" && digest.test(invocation), "INVALID_REQUEST", "Invalid model invocation.");
        const keys = ["operationId", ...(method === "acquire_model_admission" ? ["payment"] : []),
          ...(invocation !== undefined ? ["invocationDigest"] : [])].sort().join(",");
        requireWallet(options.scopeToSession === true && typeof input.operationId === "string" && UUID.test(input.operationId) &&
          Object.keys(input).sort().join(",") === keys,
          "INVALID_REQUEST", "A trusted model admission operation is required.");
        if (method === "acquire_model_admission") return requests.modelAdmission.acquire(handle, input.operationId, input.payment, signal, invocation);
        requests.modelAdmission.assertInvocation(handle, input.operationId, invocation);
        if (method === "model_admission_status") return confirming.has(input.operationId) ? { waiting: true, reason: "approval" } : requests.modelAdmission.status(handle, input.operationId);
        requests.modelAdmission.release(handle, input.operationId);
        return { released: true };
      }
      if (method === "prepare_payment") {
        const hostActivity = Object.hasOwn(input, "hostActivity");
        requireWallet(Object.keys(input).sort().join(",") === (hostActivity ? "hostActivity,operationId,payment" : "operationId,payment") &&
          (!hostActivity || options.scopeToSession === true) &&
          typeof input.operationId === "string" && UUID.test(input.operationId),
        "INVALID_REQUEST", "A stable client operation UUID and payment challenge are required.");
        requireWallet(!(input.payment as HostPaymentInput)?.modelRecovery || options.scopeToSession === true,
          "CLIENT_AUTHENTICATION_REQUIRED", "Model recovery is restricted to the internal host.");
        const model = (input.payment as HostPaymentInput)?.modelRecovery;
        if (model) {
          requests.modelAdmission.coverRefreshedQuote(handle, input.operationId, input.payment, model.invocationDigest);
        }
        const record = await payments.prepare(handle, input.payment as HostPaymentInput, input.operationId, input.hostActivity);
        const quote = await requests.store.quote(record);
        let assetDecimals: number | undefined;
        let authorizationScope: "once" | "session" | "persistent" | "none" = "none";
        if (options.scopeToSession) {
          const frozen = await requests.store.frozen(record);
          const payer = requests.payment.scope(handle, record, frozen, quote);
          const deadline = requestDeadline(AbortSignal.any([signal, requests.store.ctx.fence.signal]),
            REQUEST_PREPARATION_TIMEOUT_MS, requests.store.env);
          try {
            const preparedTime = await paymentStage(record.requestId, "prepare", () => requests.payment.preparationTime(handle, record, deadline.signal));
            deadline.check();
            requests.store.assertCurrent(handle, record, frozen);
            assetDecimals = networkConfig(quote.selected.network).assetDecimals;
            const ctx = requests.store.ctx, state = ctx.state.snapshot();
            const context = ctx.sessions.resolve(handle, state);
            const now = preparedTime;
            const rank = { once: 0, session: 1, persistent: 2 };
            for (const grant of [...state.grants].sort((a, b) => rank[a.scope] - rank[b.scope])) {
              try {
                checkGrant(grant, payer.scope, context, state.managementEpoch, now, ctx.sessions.hostGrantScope(handle));
                authorizationScope = grant.scope;
                break;
              } catch (error) { if (!(error instanceof WalletError)) throw error; }
            }
          } finally { deadline.close(); }
        }
        assertCurrent(signal);
        return { paymentId: record.requestId, operationId: record.operationId,
          status: record.transportStatus, paymentStatus: record.paymentStatus,
          amountAtomic: record.amountAtomic, network: record.network,
          ...(record.hostActivity && options.scopeToSession ? { hostActivity: record.hostActivity } : {}),
          ...(options.scopeToSession ? { quote: { digest: quote.digest, amountAtomic: quote.selected.amount, network: quote.selected.network,
            asset: quote.selected.asset, assetSymbol: quote.selected.extra.name, payTo: quote.selected.payTo,
            ...(assetDecimals === undefined ? {} : { assetDecimals, authorizationScope }) } } : {}) };
      }
      if (method === "read_model_binding") {
        requireWallet(options.scopeToSession === true && Object.keys(input).sort().join(",") === "invocationDigest,operationId" &&
          typeof input.operationId === "string" && UUID.test(input.operationId) &&
          typeof input.invocationDigest === "string" && digest.test(input.invocationDigest),
        "INVALID_REQUEST", "The original model invocation is required.");
        const binding = await payments.modelBinding(handle, input.operationId, input.invocationDigest);
        assertCurrent(signal);
        return binding;
      }
      if (method === "complete_model_payment") {
        requireWallet(options.scopeToSession === true && Object.keys(input).join(",") === "paymentId" &&
          typeof input.paymentId === "string" && UUID.test(input.paymentId), "INVALID_REQUEST", "The original model payment is required.");
        const record = requests.store.owned(handle, input.paymentId);
        requireWallet(record.modelPayment && record.sessionId === runtime.sessions.resolve(handle).sessionId,
          "CLIENT_AUTHENTICATION_REQUIRED", "The model payment belongs to another session.");
        await requests.modelRecovery.request(record.requestId);
        return { paymentId: record.requestId };
      }
      if (method === "read_activity") {
        requireWallet(options.scopeToSession === true && Object.keys(input).sort().join(",") ===
          (input.refresh === true ? "paymentId,refresh,sessionId,workspaceKey" : "paymentId,sessionId,workspaceKey") &&
          typeof input.paymentId === "string" && UUID.test(input.paymentId) &&
          typeof input.workspaceKey === "string" && typeof input.sessionId === "string",
        "INVALID_REQUEST", "An authenticated host activity lookup is required.");
        // Validate the protected chat binding before any network lookup of the original payment.
        let result = await payments.readActivity(handle, input.paymentId, input.workspaceKey, input.sessionId);
        if (input.refresh === true && ["signed", "submitted", "observed"].includes(result.paymentStatus)) {
          assertCurrent(signal);
          await requests.reconcile(handle, input.paymentId, signal);
          result = await payments.readActivity(handle, input.paymentId, input.workspaceKey, input.sessionId);
        }
        assertCurrent(signal);
        return result;
      }
      const hinted = method === "reconcile_payment" && Object.hasOwn(input, "transactionHash");
      const quoteBound = method === "authorize_payment" && Object.hasOwn(input, "quoteDigest");
      const allowed = method === "authorize_payment" ? (quoteBound ? "paymentId,quoteDigest,requestDigest" : "paymentId,requestDigest") : hinted ? "paymentId,transactionHash" : "paymentId";
      requireWallet(Object.keys(input).sort().join(",") === allowed && typeof input.paymentId === "string" && UUID.test(input.paymentId),
        "INVALID_REQUEST", "An original payment reference is required.");
      const id = input.paymentId;
      requireWallet(!hinted || (typeof input.transactionHash === "string" && /^0x[0-9a-f]{64}$/i.test(input.transactionHash)),
        "INVALID_REQUEST", "A transaction lookup hint must be a 32-byte hash.");
      if (options.scopeToSession) requireWallet(requests.store.owned(handle, id).sessionId === runtime.sessions.resolve(handle).sessionId,
        "CLIENT_AUTHENTICATION_REQUIRED", "The payment belongs to another host session.");
      if (method === "authorize_payment") {
        requireWallet(typeof input.requestDigest === "string" && digest.test(input.requestDigest),
          "INVALID_REQUEST", "The original request digest is required.");
        requireWallet(!quoteBound || (typeof input.quoteDigest === "string" && digest.test(input.quoteDigest)),
          "INVALID_REQUEST", "The displayed quote digest is invalid.");
        const modelRecord = requests.store.owned(handle, id);
        requireWallet(!active.has(id) && active.size < hostPaymentSigningLimit(modelRecord), "WALLET_BUSY", "The payment is already running or the signing slots are full.");
        if (modelRecord.modelPayment) requests.modelAdmission.assert(handle, modelRecord.operationId);
        const requestDigest = input.requestDigest;
        const controller = new AbortController();
        active.set(id, controller);
        const combined = AbortSignal.any([signal, controller.signal]);
        try {
          return await paymentStage(id, "authorization", async () => {
          try { return await payments.submit(handle, id, requestDigest, combined, undefined, input.quoteDigest as string | undefined); }
          catch (error) {
            if (!(error instanceof WalletError) || !["PAYMENT_APPROVAL_REQUIRED", "WALLET_LOCKED"].includes(error.code) || !options.present) throw error;
          }
          if (modelRecord.modelPayment) await requests.modelAdmission.alone(handle, modelRecord.operationId, combined);
          const view = await requests.approvals.prepare(handle, id, combined);
          if (modelRecord.modelPayment) confirming.add(modelRecord.operationId);
          try { await paymentStage(id, "approval_wait", () => abortable(options.present!(options.scopeToSession ? { ...view, allowPersistent: false } : view, async choice => {
            assertCurrent(combined);
            requireWallet(!options.scopeToSession || choice !== "persistent", "INVALID_REQUEST", "Persistent approval is unavailable for this client.");
            return requests.approvals.decide(handle, view.approvalId, choice, combined);
          }, combined), combined)); } finally { confirming.delete(modelRecord.operationId); }
          assertCurrent(combined);
          if (modelRecord.modelPayment) requests.modelAdmission.assert(handle, modelRecord.operationId);
          // Retain admission until the asynchronous signing path finishes its final checks.
          return await payments.submit(handle, id, requestDigest, combined, view.wallet.walletId, input.quoteDigest as string | undefined);
          });
        } catch (error) {
          if (combined.aborted) {
            try { await requests.cancel(handle, id); }
            catch { /* Preserve the original cancellation and any existing signed risk. */ }
          }
          throw error;
        } finally {
          active.delete(id);
          if (modelRecord.modelPayment) {
            try { requests.modelAdmission.release(handle, modelRecord.operationId); } catch { /* Session revocation fences signing; admission also expires. */ }
          }
        }
      }
      if (method === "get_payment") return requests.get(handle, id);
      if (method === "reconcile_payment") return requests.reconcile(handle, id, signal, input.transactionHash as string | undefined);
      if (method === "cancel_payment") {
        requests.store.owned(handle, id);
        active.get(id)?.abort(new WalletError("WALLET_REQUEST_CANCELED", "The caller canceled the original payment."));
        return requests.cancel(handle, id);
      }
      throw new WalletError("METHOD_NOT_FOUND", "The payment operation is unavailable.");
    },
  };
}
