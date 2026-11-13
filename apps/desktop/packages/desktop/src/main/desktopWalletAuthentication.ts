type AuthenticationRunner = (signal: AbortSignal) => Promise<void>;

/** A host lock or window close invalidates authentication that has not returned. */
export class DesktopWalletAuthentication {
  private pending?: AbortController;

  constructor(private readonly run: AuthenticationRunner, private readonly timeoutMs = 60_000) {}

  async authenticate(): Promise<void> {
    if (this.pending) throw new Error("Wallet authentication is already in progress.");
    const controller = new AbortController();
    this.pending = controller;
    const operation = Promise.resolve().then(() => this.run(controller.signal)).finally(() => {
      // Do not allow a second approval until the original has actually settled.
      if (this.pending === controller) this.pending = undefined;
    });
    const canceled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    try {
      await Promise.race([operation, canceled]);
      controller.signal.throwIfAborted();
    } finally {
      clearTimeout(timer);
    }
  }

  cancelPending(): void {
    this.pending?.abort();
  }
}

/** No system prompt is shown. This is the seam where the wallet password will be checked. */
export function directWalletAuthentication(): DesktopWalletAuthentication {
  return new DesktopWalletAuthentication(async (signal) => {
    signal.throwIfAborted();
  });
}
