import * as wallet from "@koincode/wallet/node";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Registered third-party clients share the wallet's existing native approval presenter. */
export class WalletExternalPayments {
  private socket?: Awaited<ReturnType<typeof wallet.startWalletSocket>>;
  private readonly decisions = new Map<string, {
    approvalId: string;
    decide: (choice: wallet.PaymentApprovalChoice) => Promise<unknown>;
  }>();
  constructor(private readonly present: (connectionId: string, view: wallet.PaymentApprovalView,
    signal: AbortSignal) => Promise<void>, private readonly namespace: "m4-testnet" | "mainnet") {}

  async start(service: Awaited<ReturnType<typeof wallet.openLocalWalletRequests>>): Promise<void> {
    // The existing Unix adapter fails closed; Windows needs its ACL-authenticated native pipe adapter.
    if (process.platform === "win32") return;
    this.socket = await wallet.startWalletSocket(service.runtime, service.requests,
      // The socket lives in the service directory of the network this build opens.
      join(wallet.walletServiceDirectory(this.namespace), "service"), {
        presentPayment: async (view, decide, signal) => {
          const connectionId = randomUUID();
          this.decisions.set(connectionId, { approvalId: view.approvalId, decide });
          try { await this.present(connectionId, view, signal); }
          finally { this.decisions.delete(connectionId); }
        },
      });
  }

  decide(connectionId: string, approvalId: string, choice: wallet.PaymentApprovalChoice,
    signal: AbortSignal): Promise<unknown> | undefined {
    const pending = this.decisions.get(connectionId);
    if (!pending) return undefined;
    signal.throwIfAborted();
    if (pending.approvalId !== approvalId) return Promise.reject(new Error("PAYMENT_CONTEXT_CHANGED"));
    return pending.decide(choice);
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    await socket?.close();
    this.decisions.clear();
  }
}
