import { generalNetwork } from "../domain/generalNetworks.js";
import { WalletError } from "../domain/errors.js";
import type { GeneralBalanceRpc } from "./generalBalances.js";

type Pending = {
  networkId: string;
  signal: AbortSignal;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
};

/** New-wallet read-only resource pool; it must live in the new utility process. */
export class GeneralRpcScheduler {
  private readonly pending: Pending[] = [];
  private readonly activeByNetwork = new Map<string, number>();
  private readonly shutdown = new AbortController();
  private active = 0;
  private closed = false;

  wrap(networkId: string, rpc: GeneralBalanceRpc): GeneralBalanceRpc {
    generalNetwork(networkId);
    return { call: (method, params, signal) => {
      const combined = AbortSignal.any([signal, this.shutdown.signal]);
      return this.enqueue(networkId, combined, () => rpc.call(method, params, combined));
    } };
  }

  close(): void {
    this.closed = true;
    this.shutdown.abort();
    for (const item of this.pending.splice(0)) {
      item.signal.removeEventListener("abort", item.onAbort);
      item.reject(new WalletError("BALANCE_READ_CANCELED", "Balance reading was canceled or timed out."));
    }
  }

  private enqueue(networkId: string, signal: AbortSignal, run: () => Promise<unknown>): Promise<unknown> {
    if (this.closed || signal.aborted) return Promise.reject(new WalletError("BALANCE_READ_CANCELED", "Balance reading was canceled or timed out."));
    if (this.pending.length >= 32) return Promise.reject(new WalletError("BALANCE_BUSY", "The balance queue is full."));
    return new Promise((resolve, reject) => {
      const item: Pending = { networkId, signal, run, resolve, reject, onAbort: () => {
        const index = this.pending.indexOf(item);
        if (index < 0) return;
        this.pending.splice(index, 1);
        reject(new WalletError("BALANCE_READ_CANCELED", "Balance reading was canceled or timed out."));
        this.drain();
      } };
      signal.addEventListener("abort", item.onAbort, { once: true });
      this.pending.push(item);
      this.drain();
    });
  }

  private drain(): void {
    while (!this.closed && this.active < 8) {
      const index = this.pending.findIndex((item) => (this.activeByNetwork.get(item.networkId) ?? 0) < 4);
      if (index < 0) return;
      const [item] = this.pending.splice(index, 1);
      if (!item) return;
      item.signal.removeEventListener("abort", item.onAbort);
      if (item.signal.aborted) {
        item.reject(new WalletError("BALANCE_READ_CANCELED", "Balance reading was canceled or timed out."));
        continue;
      }
      this.active++;
      this.activeByNetwork.set(item.networkId, (this.activeByNetwork.get(item.networkId) ?? 0) + 1);
      // Keep the slot until the transport settles, even if it ignores cancellation.
      void Promise.resolve().then(() => {
        if (item.signal.aborted || this.closed) throw new WalletError("BALANCE_READ_CANCELED", "Balance reading was canceled or timed out.");
        return item.run();
      }).then(item.resolve, item.reject).finally(() => {
        this.active--;
        const remaining = (this.activeByNetwork.get(item.networkId) ?? 1) - 1;
        if (remaining) this.activeByNetwork.set(item.networkId, remaining);
        else this.activeByNetwork.delete(item.networkId);
        this.drain();
      });
    }
  }
}
