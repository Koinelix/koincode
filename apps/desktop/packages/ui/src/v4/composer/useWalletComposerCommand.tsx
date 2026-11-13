import { useRef, useState } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";

/** The ordinary renderer can request a window, never a wallet operation. */
export function useWalletComposerCommand(local: boolean) {
  const platform = useOptionalPlatform();
  const { intl } = useFCodeIntl();
  const pending = useRef(false);
  const [failed, setFailed] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const command: AppSlashCommand | undefined = local && platform?.walletUi ? {
    value: "wallet",
    trustedUiAction: "wallet-manager",
    description: intl.formatMessage({ id: "wallet.open" }),
    run: () => {
      if (pending.current) return;
      pending.current = true;
      setIsOpening(true);
      setFailed(false);
      void platform.walletUi!.open().catch(() => setFailed(true)).finally(() => { pending.current = false; setIsOpening(false); });
    },
  } : undefined;
  return { command, isOpening, notice: failed ? <p role="alert" className="px-3 py-2 text-destructive">
    {intl.formatMessage({ id: "wallet.openFailed" })}
  </p> : null };
}
