import type { RemoteHostChallenge } from "@fcode/shared";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";

export function RemoteHostTrustDialog({ challenge, changed, pending, onAccept, onClose }: {
  challenge: RemoteHostChallenge; changed: boolean; pending: boolean; onAccept(): void; onClose(): void;
}) {
  const { intl } = useFCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `remoteHosts.${key}` });
  return <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
    <DialogContent aria-describedby="remote-host-trust-description"><DialogHeader><DialogTitle>{t(changed ? "trust.changed" : "trust.initial")}</DialogTitle></DialogHeader>
      <p id="remote-host-trust-description" className={changed ? "text-destructive" : "text-foreground-subtlest"}>{t(changed ? "trust.changedHelp" : "trust.help")}</p>
      <dl className="space-y-3 text-ui-base"><div><dt>{challenge.endpoint}</dt><dd>{challenge.keyType}</dd></div>
        <div><dt>{t("fingerprint")}</dt><dd className="break-all rounded-md bg-muted p-3 font-mono select-text">{challenge.fingerprint}</dd></div></dl>
      <DialogFooter><Button variant="outline" disabled={pending} onClick={onClose}>{t("cancel")}</Button>
        <Button variant={changed ? "destructive" : "default"} disabled={pending} onClick={onAccept}>{t(changed ? "trust.reset" : "trust.accept")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
