import type { HostPaymentInput, HostPaymentMaterial, HostPaymentPrepared } from "../domain/requestModel.js";
import { requireWallet, WalletError } from "../domain/errors.js";
import { HostPayments, hostPaymentJournalInput, validateHostPayment } from "../app/hostPayments.js";
import type { ClientHandle } from "../app/sessions.js";
import type { WalletRequests } from "../app/requests.js";
import type { DurableOperationAdapter } from "./durableOperations.js";
import type { PaymentApprovalView } from "../app/paymentApprovalTypes.js";

export type HostPaymentWait = { signal: AbortSignal; approvalId?: string; walletId?: string };
type Run = <T>(signal: AbortSignal | undefined, action: (combined: AbortSignal) => Promise<T>) => Promise<T>;

/** Private host session only. Payment material never passes through the MCP dispatcher. */
export function createHostPaymentSession(options: {
  requests: WalletRequests;
  payments: HostPayments;
  handle: ClientHandle;
  journal: DurableOperationAdapter;
  present?: (view: PaymentApprovalView, signal: AbortSignal) => Promise<void>;
  active: Set<string>;
  waits: Map<string, HostPaymentWait>;
  run: Run;
  assertLive: () => void;
}) {
  const { requests, payments, handle, journal, present, active, waits, run, assertLive } = options;
  return {
    prepareHostPayment: (input: HostPaymentInput, source: string, signal?: AbortSignal): Promise<HostPaymentPrepared> => {
      const snapshot = validateHostPayment(input);
      requireWallet(typeof source === "string" && /^[0-9a-f]{64}$/.test(source),
        "OPERATION_CONTEXT_REQUIRED", "A trusted host action identity is required.");
      return run(signal, async (combined) => {
        const operation = await journal.prepareAnchored(`host-payment:${source}`, hostPaymentJournalInput(snapshot), {
          commit: checkpoint => requests.journalAnchors.commit(handle, checkpoint),
        });
        combined.throwIfAborted();
        const prepared = await payments.prepare(handle, snapshot, operation.operationId);
        combined.throwIfAborted();
        return { ...requests.get(handle, prepared.requestId), walletFrozenDigest: prepared.frozenDigest,
          walletInputDigest: prepared.inputDigest,
          walletClient: { ...requests.store.ctx.sessions.resolve(handle), managementEpoch: prepared.epoch },
          walletCreatedBy: { sessionId: prepared.sessionId, generation: prepared.generation } };
      });
    },
    submitHostPayment: (id: string, requestDigest: string, signal?: AbortSignal): Promise<HostPaymentMaterial> =>
      run(signal, async (combined) => {
        requireWallet(!active.has(id), "WALLET_BUSY", "The host payment is already in progress.");
        active.add(id);
        try {
          try { return await payments.submit(handle, id, requestDigest, combined); }
          catch (error) {
            if (!(error instanceof WalletError) || !["PAYMENT_APPROVAL_REQUIRED", "WALLET_LOCKED"].includes(error.code) || !present) throw error;
          }
          const wait: HostPaymentWait = { signal: combined };
          waits.set(id, wait);
          try {
            for (let attempt = 0; attempt < 2; attempt++) {
              const view = await requests.approvals.prepare(handle, id, combined);
              requireWallet(wait.walletId === undefined || view.wallet.walletId === wait.walletId,
                "PAYMENT_CONTEXT_CHANGED", "The displayed payment wallet changed.");
              wait.walletId = view.wallet.walletId;
              wait.approvalId = view.approvalId;
              await present(view, combined);
              assertLive(); combined.throwIfAborted();
              requireWallet(requests.get(handle, id).transportStatus !== "canceled",
                "PAYMENT_REJECTED", "The payment was rejected.");
              try { return await payments.submit(handle, id, requestDigest, combined, wait.walletId); }
              catch (error) {
                if (!(error instanceof WalletError) || error.code !== "WALLET_LOCKED" || attempt === 1) throw error;
              }
            }
            throw new WalletError("PAYMENT_APPROVAL_REQUIRED", "The payment approval is unavailable.");
          } finally { waits.delete(id); }
        } catch (error) {
          if (combined.aborted) {
            try {
              if (!requests.get(handle, id).paymentIntentId) await requests.cancel(handle, id);
            } catch {
              // Preserve the original cancellation or payment outcome.
            }
          }
          throw error;
        } finally { active.delete(id); }
      }),
  };
}
