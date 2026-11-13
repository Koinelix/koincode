import { randomUUID } from "node:crypto";
import { WalletError } from "@koincode/wallet";
import {
  walletPaymentViewSchema,
  walletPaymentDecisionSchema,
  type WalletPaymentNotice,
  type WalletPaymentChoice,
} from "@fcode/shared";
import type { HostPaymentPresenter } from "@koincode/wallet/node";

type Entry = {
  notice: WalletPaymentNotice;
  control: AbortController;
  signal: AbortSignal;
  processing: boolean;
  finish(error?: unknown): void;
};
const error = (code: string) => new WalletError(code, "The trusted payment confirmation did not complete.");

/** Owns waiting presentation lifetimes, never grants, permits or ledger facts. */
export class WalletPaymentPrompts {
  private generation = randomUUID();
  private readonly entries = new Map<string, Entry>();
  private disposed = false;
  constructor(
    private readonly post: (value: unknown) => void,
    private readonly decideConnection: (
      connectionId: string,
      approvalId: string,
      choice: WalletPaymentChoice,
      signal: AbortSignal,
    ) => Promise<unknown>,
    private readonly unlock: (walletId: string, signal: AbortSignal, authenticated: boolean) => Promise<unknown>,
  ) {}

  presenter(connectionId: string): HostPaymentPresenter {
    return (raw, signal) => {
      const view = walletPaymentViewSchema.parse(raw);
      if (
        this.disposed ||
        signal.aborted ||
        !view.expiresInMs ||
        this.entries.size >= 32 ||
        this.entries.has(view.approvalId)
      )
        return Promise.reject(error("PAYMENT_APPROVAL_UNAVAILABLE"));
      return new Promise<void>((resolve, reject) => {
        const control = new AbortController();
        let ended = false;
        const notice: WalletPaymentNotice = {
          type: "payment-request",
          generation: this.generation,
          connectionId,
          view,
        };
        const abort = () => this.remove(view.approvalId, error("WALLET_OPERATION_ABORTED"));
        const timer = setTimeout(
          () => this.remove(view.approvalId, error("QUOTE_EXPIRED")),
          view.expiresInMs,
        );
        timer.unref();
        const entry: Entry = {
          notice,
          control,
          signal,
          processing: false,
          finish: (failure) => {
            if (ended) return;
            ended = true;
            control.abort();
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            if (failure) reject(failure);
            else resolve();
          },
        };
        this.entries.set(view.approvalId, entry);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        try {
          this.post(structuredClone(notice));
        } catch {
          this.remove(view.approvalId, error("WALLET_CHANNEL_CLOSED"));
        }
      });
    };
  }

  async decide(raw: unknown): Promise<boolean> {
    const command = walletPaymentDecisionSchema.parse(raw);
    const entry = this.entries.get(command.approvalId);
    if (
      !entry ||
      entry.notice.generation !== command.generation ||
      entry.processing ||
      this.disposed
    )
      return false;
    const current = () => {
      if (
        this.entries.get(command.approvalId) !== entry ||
        entry.signal.aborted ||
        entry.control.signal.aborted
      )
        throw error("WALLET_OPERATION_ABORTED");
    };
    entry.processing = true;
    try {
      current();
      await this.decideConnection(
        entry.notice.connectionId,
        command.approvalId,
        command.choice,
        entry.control.signal,
      );
      current();
      if (command.choice !== "deny") {
        await this.unlock(entry.notice.view.wallet.walletId, entry.control.signal, command.authenticated === true);
        current();
      }
      this.remove(command.approvalId);
      return true;
    } catch (failure) {
      this.remove(command.approvalId, failure);
      throw failure;
    }
  }
  invalidate(): void {
    this.generation = randomUUID();
    for (const id of Array.from(this.entries.keys()))
      this.remove(id, error("WALLET_OPERATION_ABORTED"));
  }
  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }
  private remove(id: string, failure?: unknown): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    entry.finish(failure);
    try {
      this.post({ type: "payment-closed", generation: entry.notice.generation, approvalId: id });
    } catch {
      /* The request is already fenced. */
    }
  }
}

/** The UI snapshot can predate idle expiry; the runtime remains the unlock-state owner. */
export async function unlockPaymentWallet(
  runtime: {
    listForDisplay(): Array<{ walletId: string; locked: boolean }>;
    management: {
      execute(
        command: { action: "unlock"; walletId: string; scope?: "application" },
        signal: AbortSignal,
      ): Promise<unknown>;
    };
  },
  walletId: string,
  signal: AbortSignal,
  authenticated: boolean,
): Promise<void> {
  if (signal.aborted) throw error("WALLET_OPERATION_ABORTED");
  const wallet = runtime.listForDisplay().find((value) => value.walletId === walletId);
  if (!wallet) throw error("WALLET_NOT_FOUND");
  if (wallet.locked) {
    if (!authenticated) throw error("WALLET_LOCKED");
    await runtime.management.execute({ action: "unlock", walletId, scope: "application" }, signal);
  }
}
