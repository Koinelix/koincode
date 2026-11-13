/** Bounded observation while an explicit management operation is in flight. */
export class DesktopWalletInteraction {
  readonly canceled: Promise<never>;
  private interval?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private stopped = false;
  cancel: () => void = () => {};
  constructor(current: () => boolean, invalidate: () => void) {
    this.canceled = new Promise<never>((_resolve, reject) => {
      const cancel = () => {
        if (this.stopped) return;
        this.stop();
        try {
          invalidate();
        } catch {
          // Cancellation remains final even if the host cannot prove a lock.
        }
        reject(new Error("WALLET_INTERACTION_CANCELED"));
      };
      this.cancel = cancel;
      this.interval = setInterval(() => {
        try {
          if (!current()) cancel();
        } catch {
          cancel();
        }
      }, 100);
      this.deadline = setTimeout(cancel, 90000);
      this.interval.unref();
      this.deadline.unref();
    });
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.interval);
    clearTimeout(this.deadline);
  }
}
