import { WalletError, requireWallet } from "../domain/errors.js";
import { timestamp } from "../domain/atomic.js";
export interface ClockSources {
  monotonic: () => number;
  wall: () => number;
}
export class TrustedWalletClock {
  private anchor: { chainTime: number; monotonic: number; wall: number } | null = null;
  constructor(
    private readonly sources: ClockSources,
    private readonly maxAgeMs = 30000,
  ) {
    requireWallet(
      Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0 && maxAgeMs <= 60000,
      "INVALID_TIME",
      "A bounded trusted clock lifetime is required.",
    );
  }
  update(chainTime: number, persistedTime: number): number {
    timestamp(chainTime);
    timestamp(persistedTime);
    const monotonic = this.sources.monotonic(),
      wall = this.sources.wall();
    requireWallet(
      Number.isFinite(monotonic) && Number.isFinite(wall),
      "CHAIN_TIME_STALE",
      "Clock sources are unavailable.",
    );
    requireWallet(
      Math.abs(wall / 1000 - chainTime) <= 60,
      "CHAIN_TIME_STALE",
      "The chain timestamp is inconsistent with the host clock.",
    );
    requireWallet(
      persistedTime - chainTime <= this.maxAgeMs / 1000,
      "CHAIN_TIME_STALE",
      "The chain timestamp is older than persisted wallet time.",
    );
    this.anchor = { chainTime: Math.max(chainTime, persistedTime), monotonic, wall };
    return this.now();
  }
  /** Keep enough of the trusted-time window for the native final check after a queued handoff. */
  sampleFreshness(): () => boolean {
    const monotonic = this.sources.monotonic(), wall = this.sources.wall();
    return () => {
      const ageMs = this.sources.monotonic() - monotonic;
      return ageMs >= 0 && ageMs < this.maxAgeMs / 2 && Math.abs(this.sources.wall() - wall - ageMs) <= 2000;
    };
  }
  now(): number {
    const anchor = this.anchor;
    if (!anchor)
      throw new WalletError("CHAIN_TIME_STALE", "A fresh trusted chain sample is required.");
    const elapsed = this.sources.monotonic() - anchor.monotonic;
    const wallElapsed = this.sources.wall() - anchor.wall;
    requireWallet(
      Number.isFinite(elapsed) &&
        elapsed >= 0 &&
        elapsed <= this.maxAgeMs &&
        Math.abs(wallElapsed - elapsed) <= 2000,
      "CHAIN_TIME_STALE",
      "Wallet time must be refreshed after clock drift or stale chain data.",
    );
    return timestamp(anchor.chainTime + Math.floor(elapsed / 1000));
  }
  invalidate(): void {
    this.anchor = null;
  }
}
