import { useRef, useState } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import { walletOpenFailureMessageId } from "./walletOpenFailure.js";

/** The ordinary renderer can request a window, never a wallet operation. */
export function useWalletComposerCommand(local: boolean) {
  const platform = useOptionalPlatform();
  const { intl } = useFCodeIntl();
  const pending = useRef(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  const command: AppSlashCommand | undefined = local && platform?.walletUi ? {
    value: "wallet",
    trustedUiAction: "wallet-manager",
    description: intl.formatMessage({ id: "wallet.open" }),
    run: () => {
      if (pending.current) return;
      pending.current = true;
      setIsOpening(true);
      setFailed(null);
      void platform.walletUi!.open().catch(error => setFailed(walletOpenFailureMessageId(error))).finally(() => { pending.current = false; setIsOpening(false); });
    },
  } : undefined;
  return { command, isOpening, notice: failed ? <p role="alert" className="px-3 py-2 text-destructive">
    {intl.formatMessage({ id: failed })}
  </p> : null };
}
