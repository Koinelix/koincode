import type { DesktopWalletWindowOptions } from "./desktopWalletWindowPolicy.js";

/** Cancel UI work without revoking a payment already accepted by the wallet. */
export function invalidateWalletPresentation(
  options: Pick<DesktopWalletWindowOptions, "wallet" | "cancelAuthentication">,
  invalidateEpoch: () => void,
  idlePresentation: boolean,
): void {
  if (idlePresentation) {
    invalidateEpoch();
    options.cancelAuthentication();
    return;
  }
  try {
    options.wallet.cancelHostInteraction();
  } catch {
    invalidateEpoch();
    try { options.cancelAuthentication(); } catch { /* The epoch fences late UI results. */ }
    throw new Error("WALLET_INTERACTION_UNCERTAIN");
  }
}

/** Approval can finish after READY but before asynchronous window startup settles. */
export function dismissWalletAfterStartup(opening: Promise<void> | undefined, dismiss: () => void): void {
  void Promise.resolve(opening).then(dismiss).catch(() => {
    // Startup failure owns cleanup; never turn a committed approval into a retry.
  });
}
