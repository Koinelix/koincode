import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";

/** The normal settings renderer may request a window but cannot read credentials. */
export function ServiceCredentialsSettingsSection() {
  const platform = useOptionalPlatform();
  const { intl } = useFCodeIntl();
  const opened = useRef(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const open = () => {
    if (!platform?.serviceCredentialsUi || pending) return;
    setPending(true); setFailed(false);
    void platform.serviceCredentialsUi.open().catch(() => setFailed(true)).finally(() => setPending(false));
  };
  useEffect(() => {
    if (!opened.current && platform?.serviceCredentialsUi) { opened.current = true; open(); }
  }, [platform]);
  return <section className="space-y-4">
    <p className="text-muted-foreground">{intl.formatMessage({ id: "serviceCredentials.description" })}</p>
    <Button type="button" disabled={!platform?.serviceCredentialsUi || pending} onClick={open}>
      {intl.formatMessage({ id: "serviceCredentials.open" })}
    </Button>
    {failed && <p role="alert" className="text-destructive">{intl.formatMessage({ id: "serviceCredentials.openFailed" })}</p>}
  </section>;
}
