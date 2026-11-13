import { ConfigOverlay, type ConfigValidationIssue } from "../config-overlay.js";

/** Wallet access carries no API credential or environment-key fallback. */
export class WalletAccessConfig extends ConfigOverlay<WalletAccessConfig> {
  readonly type = "x402-wallet" as const;
  constructor() { super(); Object.freeze(this); }
  overlay(_next: WalletAccessConfig): WalletAccessConfig { return this; }
  validateComplete(_path: readonly string[] = []): readonly ConfigValidationIssue[] { return []; }
  toJSON(): { type: "x402-wallet" } { return { type: this.type }; }
}
