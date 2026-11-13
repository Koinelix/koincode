import type { BrowserWindow } from "electron";

type Account = { walletId: string; address: string };

/** Ephemeral display facts from an already completed legacy status; this does not query or control that wallet. */
export class DesktopLegacyAccountSnapshot {
  private value?: { window: BrowserWindow; generation: number; stateGeneration: number; sequence: number; wallets: Account[] };
  clear(): void { this.value = undefined; }
  publish(window: BrowserWindow, generation: number, stateGeneration: number, sequence: number, wallets: readonly Account[]): void {
    this.value = { window, generation, stateGeneration, sequence, wallets: wallets.map(({ walletId, address }) => ({ walletId, address })) };
  }
  read(window: BrowserWindow, generation: number, stateGeneration: number, sequence: number, current: boolean): readonly Account[] | null {
    const snapshot = this.value;
    return current && snapshot && snapshot.window === window && snapshot.generation === generation &&
      snapshot.stateGeneration === stateGeneration && snapshot.sequence === sequence ? snapshot.wallets : null;
  }
}
