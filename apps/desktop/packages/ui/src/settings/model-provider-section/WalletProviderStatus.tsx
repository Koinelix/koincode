import { Button } from "@/components/ui/button.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import { useWalletComposerCommand } from "@/v4/composer/useWalletComposerCommand.js";

export function WalletProviderStatus() {
  const { intl } = useFCodeIntl();
  const wallet = useWalletComposerCommand(true);
  return <div className="space-y-3 text-ui-sm">
    <p className="text-foreground-subtle">{intl.formatMessage({ id: "wallet.provider.description" })}</p>
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" disabled={!wallet.command || wallet.isOpening} onClick={() => wallet.command?.run()}>
        {intl.formatMessage({ id: "wallet.open" })}
      </Button>
      <a href="https://koinelix.com" target="_blank" rel="noreferrer" className="underline">
        {intl.formatMessage({ id: "wallet.provider.website" })}
      </a>
    </div>
    <p className="text-foreground-subtle">{intl.formatMessage({ id: "wallet.provider.quote" })}</p>
    {wallet.notice}
  </div>;
}
