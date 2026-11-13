import { useEffect, useRef, useState } from "react";
import type { RemoteExecutionRecord, RemoteReconciliationPreview } from "@fcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog.js";

export function RemoteHostReconciliationButton({ record, workspaceKey, sessionId, onResult }: {
  record: RemoteExecutionRecord; workspaceKey: string; sessionId: string; onResult(record: RemoteExecutionRecord): void;
}) {
  const client = usePlatform().remoteHosts; const { intl } = useFCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `remoteHosts.${key}` });
  const [preview, setPreview] = useState<RemoteReconciliationPreview>();
  const [pending, setPending] = useState(false); const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const prepare = async () => {
    if (!client || pending) return; setPending(true); setError("");
    try {
      const next = await client.request("prepareReconciliation", { workspaceKey, sessionId, executionId: record.executionId });
      if (alive.current) setPreview(next);
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : t("requestFailed")); }
    finally { if (alive.current) setPending(false); }
  };
  const reconcile = async () => {
    if (!client || !preview || pending) return; setPending(true); setError("");
    try {
      const next = await client.request("reconcileExecution", { workspaceKey, sessionId, reconciliationId: preview.reconciliationId });
      if (alive.current) { setPreview(undefined); onResult(next); }
    } catch (failure) { if (alive.current) { setPreview(undefined); setError(failure instanceof Error ? failure.message : t("requestFailed")); } }
    finally { if (alive.current) setPending(false); }
  };
  return <>
    <Button variant="outline" size="sm" disabled={pending} onClick={() => void prepare()}>{t("reconcile")}</Button>
    {error && <p role="alert" className="break-all text-destructive">{error}</p>}
    {preview && <Dialog open onOpenChange={(open) => { if (!open && !pending) setPreview(undefined); }}>
      <DialogContent aria-describedby="remote-host-reconcile-description"><DialogHeader><DialogTitle>{t("reconcile")}</DialogTitle></DialogHeader>
        <p id="remote-host-reconcile-description">{t("reconcileHelp")}</p>
        <p className="break-all">{preview.display.name} · {preview.display.username}@{preview.display.endpoint}</p>
        {!!preview.paths.length && <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-ui-sm">{preview.paths.join("\n")}</pre>}
        {!preview.canVerifyPublication && <p>{t("reconcileNoReceipt")}</p>}
        <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setPreview(undefined)}>{t("cancel")}</Button>
          <Button disabled={pending} onClick={() => void reconcile()}>{t("confirmRead")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>}
  </>;
}
