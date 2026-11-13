import { requireWallet } from "../domain/errors.js";
import type { SecurityFence } from "./securityFence.js";
import type { WalletUnlocks } from "./unlock.js";
export class WalletControls {
  #queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly fence: SecurityFence,
    private readonly unlocks: WalletUnlocks,
  ) {}
  run<T>(change: () => Promise<T>): Promise<T> {
    const end = this.fence.beginControl();
    this.unlocks.invalidatePending();
    const operation = this.#queue
      .then(() => {
        requireWallet(
          !this.fence.signal.aborted,
          "WALLET_CLOSED",
          "The wallet service is closing.",
        );
        return change();
      })
      .finally(end);
    this.#queue = operation.catch(() => {});
    return operation;
  }
  async drain(): Promise<void> {
    await this.#queue;
  }
}
