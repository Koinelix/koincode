import { WalletError, requireWallet } from "../domain/errors.js";

/** The local payment owner shares one signer / store writer. Wait before minting a signing permit. */
export function localPaymentSigner() {
  let signing = false;
  const waiters = new Set<() => void>();
  return async (signal: AbortSignal): Promise<() => void> => {
    const aborted = () => new WalletError("WALLET_OPERATION_ABORTED", "Waiting for the local signer was canceled.");
    if (signal.aborted) throw aborted();
    if (signing) {
      requireWallet(waiters.size < 16, "WALLET_BUSY", "The local signing queue is full.");
      await new Promise<void>((resolve, reject) => {
        const enter = () => { signal.removeEventListener("abort", cancel); resolve(); };
        const cancel = () => { waiters.delete(enter); reject(aborted()); };
        waiters.add(enter);
        signal.addEventListener("abort", cancel, { once: true });
      });
    }
    signing = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.values().next().value;
      if (next) { waiters.delete(next); next(); }
      else signing = false;
    };
  };
}
