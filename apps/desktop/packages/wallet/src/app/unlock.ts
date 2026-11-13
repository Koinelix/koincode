import { requireWallet } from "../domain/errors.js";
export class WalletUnlocks {
  #systemProtection = false;
  #windows = new Map<string, { until: number | null; lastUsed: number; idleMs: number | null }>();
  #generation = 0;
  #lockGeneration = 0;
  #hostContext = new AbortController();
  get hostContextSignal(): AbortSignal { return this.#hostContext.signal; }
  private interruptHost(): void {
    this.#hostContext.abort();
    this.#hostContext = new AbortController();
  }
  #interactionGeneration = 0;
  get lockGeneration(): number {
    return this.#lockGeneration;
  }
  get interactionGeneration(): number {
    return this.#interactionGeneration;
  }
  constructor(private readonly monotonic: () => number) {}
  get requiresExplicitUnlock(): boolean {
    return !this.#systemProtection;
  }
  useSystemProtection(): void {
    if (this.#systemProtection) return;
    this.lock();
    this.#systemProtection = true;
  }
  unlock(walletId: string, durationMs = 300000, idleMs = 60000): void {
    requireWallet(
      Number.isSafeInteger(durationMs) &&
        durationMs > 0 &&
        durationMs <= 900000 &&
        Number.isSafeInteger(idleMs) &&
        idleMs > 0 &&
        idleMs <= durationMs,
      "INVALID_UNLOCK_DURATION",
      "Unlock duration and idle timeout must be bounded.",
    );
    const now = this.monotonic();
    requireWallet(
      Number.isFinite(now) && now >= 0,
      "WALLET_LOCKED",
      "The monotonic clock is unavailable.",
    );
    this.#generation++;
    this.#windows.set(walletId, { until: now + durationMs, lastUsed: now, idleMs });
  }
  unlockForApplication(walletId: string): void {
    const now = this.monotonic();
    requireWallet(
      Number.isFinite(now) && now >= 0,
      "WALLET_LOCKED",
      "The monotonic clock is unavailable.",
    );
    this.#generation++;
    this.#windows.set(walletId, { until: null, lastUsed: now, idleMs: null });
  }
  isUnlocked(walletId: string): boolean {
    const current = this.#windows.get(walletId),
      now = this.monotonic();
    if (this.#systemProtection) return Number.isFinite(now) && now >= 0;
    return (
      !!current &&
      Number.isFinite(now) &&
      now >= current.lastUsed &&
      (current.until === null || now < current.until) &&
      (current.idleMs === null || now - current.lastUsed < current.idleMs)
    );
  }
  isApplicationUnlocked(walletId: string): boolean {
    if (this.#systemProtection) return this.isUnlocked(walletId);
    return this.#windows.get(walletId)?.until === null && this.isUnlocked(walletId);
  }
  /** A conservative snapshot for trusted host display; it never extends an unlock. */
  displayState(walletId: string): { locked: boolean; unlockRemainingMs: number | null } {
    if (this.#systemProtection)
      return { locked: !this.isUnlocked(walletId), unlockRemainingMs: null };
    const current = this.#windows.get(walletId),
      now = this.monotonic();
    if (
      !current ||
      !Number.isFinite(now) ||
      now < current.lastUsed ||
      (current.until !== null && now >= current.until) ||
      (current.idleMs !== null && now - current.lastUsed >= current.idleMs)
    )
      return { locked: true, unlockRemainingMs: null };
    if (current.until === null || current.idleMs === null)
      return { locked: false, unlockRemainingMs: null };
    const remaining = Math.min(current.until - now, current.idleMs - (now - current.lastUsed));
    if (!Number.isFinite(remaining)) return { locked: true, unlockRemainingMs: null };
    return { locked: false, unlockRemainingMs: Math.max(0, Math.floor(remaining)) };
  }
  capture(walletId: string): number {
    requireWallet(this.isUnlocked(walletId), "WALLET_LOCKED", "The wallet must be unlocked.");
    return this.#generation;
  }
  assertCurrent(walletId: string, generation: number): void {
    requireWallet(
      generation === this.#generation && this.isUnlocked(walletId),
      "WALLET_LOCKED",
      "The wallet lock or security context changed before signing.",
    );
  }
  touch(walletId: string): void {
    requireWallet(this.isUnlocked(walletId), "WALLET_LOCKED", "The wallet is locked.");
    if (this.#systemProtection) return;
    this.#windows.get(walletId)!.lastUsed = this.monotonic();
  }
  invalidatePending(): void {
    this.#generation++;
  }
  cancelHostInteraction(): void {
    this.#interactionGeneration++;
    this.#generation++;
    this.#lockGeneration++;
    this.interruptHost();
  }
  lock(walletId?: string): void {
    this.#generation++;
    this.#lockGeneration++;
    this.interruptHost();
    if (walletId) this.#windows.delete(walletId);
    else this.#windows.clear();
  }
}
