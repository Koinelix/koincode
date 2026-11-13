/** One-shot invalidation of a display snapshot, never a wallet lock or a poll. */
export class DesktopWalletDisplayExpiry {
  private token = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly clock: () => number = () => performance.now(),
    private readonly schedule: (
      callback: () => void,
      delay: number,
    ) => ReturnType<typeof setTimeout> = setTimeout,
    private readonly clear: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout,
  ) {}

  cancel(): void {
    this.token++;
    if (this.timer) this.clear(this.timer);
    this.timer = undefined;
  }

  replaceForWallets(startedAt: number, wallets: readonly { unlockRemainingMs: number | null }[],
    current: () => boolean, invalidate: () => void): boolean {
    const remaining = wallets.reduce<number | null>((earliest, wallet) => wallet.unlockRemainingMs === null ? earliest
      : Math.min(earliest ?? wallet.unlockRemainingMs, wallet.unlockRemainingMs), null);
    return this.replace(startedAt, remaining, current, invalidate);
  }

  replace(
    startedAt: number,
    remainingMs: number | null,
    current: () => boolean,
    invalidate: () => void,
  ): boolean {
    this.cancel();
    if (remainingMs === null) return true;
    const now = this.clock();
    if (
      !Number.isFinite(startedAt) ||
      !Number.isFinite(now) ||
      now < startedAt ||
      !Number.isSafeInteger(remainingMs) ||
      remainingMs < 0 ||
      remainingMs > 900000
    )
      return false;
    const delay = Math.floor(remainingMs - (now - startedAt));
    if (delay <= 0) return false;
    const token = this.token;
    this.timer = this.schedule(() => {
      if (token !== this.token) return;
      this.timer = undefined;
      this.token++;
      if (current()) invalidate();
    }, delay);
    this.timer.unref();
    return true;
  }
}
