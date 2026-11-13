import { Button } from "@/components/ui/button.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import { useWalletComposerCommand } from "@/v4/composer/useWalletComposerCommand.js";
import { useEffect, useRef } from "react";

/** Settings and the composer share the same desktop-owned window entry. */
export function WalletSettingsSection() {
  const { intl } = useFCodeIntl();
  const wallet = useWalletComposerCommand(true);
  const opened = useRef(false);
  useEffect(() => {
    if (!opened.current && wallet.command) { opened.current = true; void wallet.command.run(); }
  }, [wallet.command]);
  return <section className="space-y-4">
    <p className="text-muted-foreground">{intl.formatMessage({ id: "wallet.settingsDescription" })}</p>
    <Button type="button" disabled={!wallet.command || wallet.isOpening} onClick={() => wallet.command?.run()}>
      {intl.formatMessage({ id: wallet.isOpening ? "wallet.opening" : "wallet.open" })}
    </Button>
    {wallet.notice}
  </section>;
}
