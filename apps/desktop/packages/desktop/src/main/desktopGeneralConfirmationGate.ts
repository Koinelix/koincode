import type { DesktopWalletWindowOptions } from "./desktopWalletWindowPolicy.js";

/** Owns only the new confirmation; it never reserves the legacy wallet's busy gate. */
export function createDesktopGeneralConfirmationGate(options: DesktopWalletWindowOptions, busy: ReadonlyMap<unknown, string>) {
  let active: AbortController | undefined;
  const interrupt = () => active?.abort();
  const confirm: DesktopWalletWindowOptions["confirmGeneralRpc"] = options.confirmGeneralRpc &&
    (async (window, networkId, candidate, signal) => {
      if (signal.aborted || active || busy.size || options.paymentBroker?.list().length) return false;
      const controller = active = new AbortController();
      try {
        const accepted = await options.confirmGeneralRpc!(window, networkId, candidate, AbortSignal.any([signal, controller.signal]));
        return accepted && !signal.aborted && !controller.signal.aborted && !options.paymentBroker?.list().length;
      } finally { if (active === controller) active = undefined; }
    });
  return { confirm, interrupt };
}
