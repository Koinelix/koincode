import type { WalletAdmissionActivity } from "./wallet-admission-activity.js";
import { randomUUID } from "node:crypto";
import type { WalletHostModelCall, WalletHostPort } from "@fcode/shared";
import { UnsignedAdmissionLost, UnsignedQuoteIncrease, type WalletFetchPort } from "./x402-wallet-fetch.js";

const ADMISSION_EXPIRED = "PAYMENT_ADMISSION_EXPIRED";

/** The runner supplies identity from its trusted invocation context, never from request text. */
export function createWalletModelPort(host: WalletHostPort, invocation: WalletHostModelCall["invocation"], activity?: WalletAdmissionActivity): WalletFetchPort & { finish(): Promise<void> } {
  const operations = new Set<string>();
  const call = async (operationId: string, method: WalletHostModelCall["method"], input: Record<string, unknown>, signal: AbortSignal) => {
    if (!host.modelCall) throw new Error("WALLET_MODEL_CHANNEL_UNAVAILABLE");
    const reply = await host.modelCall({ version: 1, callId: randomUUID(), operationId, invocation, method, input }, signal);
    if (!reply.ok) throw new Error(reply.code);
    return reply.value;
  };
  const complete = async (operationId: string) => {
    if (!operations.delete(operationId)) return;
    await call(operationId, "complete_payment", {}, AbortSignal.timeout(15000));
  };
  return {
    async acquire(operationId, payment, signal) {
      const stop = new AbortController();
      const observation = activity?.observe(AbortSignal.any([signal, stop.signal]),
        probe => call(operationId, "payment_wait_status", {}, probe));
      try {
        const result = await call(operationId, "acquire_payment", { payment }, signal) as { waited?: unknown };
        if (!result || typeof result.waited !== "boolean") throw new Error("WALLET_CLIENT_PROTOCOL_INVALID");
        return { waited: result.waited };
      } finally {
        stop.abort();
        await observation;
      }
    },
    async release(operationId) { await call(operationId, "release_payment", {}, AbortSignal.timeout(5000)); },
    async authorize(operationId, payment, idempotencyKey, contentType, signal) {
      // A payment that turns out to need the user's approval is admitted alone and may wait again here.
      const stop = new AbortController();
      const observation = activity?.observe(AbortSignal.any([signal, stop.signal]),
        probe => call(operationId, "payment_wait_status", {}, probe));
      try {
        try { await call(operationId, "prepare_payment", { payment, idempotencyKey, contentType }, signal); }
        catch (error) {
          if (error instanceof Error && error.message === "MODEL_QUOTE_INCREASED") throw new UnsignedQuoteIncrease(error.message);
          throw error;
        }
        operations.add(operationId);
        return await call(operationId, "authorize_payment", {}, signal) as { paymentHeader: string };
      } catch (error) {
        // Keep the wallet code as the message so an unrecovered loss still maps to its fixed diagnostic.
        if (error instanceof Error && error.message === ADMISSION_EXPIRED) throw new UnsignedAdmissionLost(error.message);
        throw error;
      }
      finally { stop.abort(); await observation; }
    },
    complete,
    async finish() { await Promise.allSettled([...operations].map(complete)); },
  };
}
