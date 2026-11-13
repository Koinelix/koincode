import { useEffect, useRef, useState } from "react";
import { remoteExecutionOutputArtifactId, type RemoteExecutionRecord, type RemoteExecutionOutputCursor, type RemoteExecutionOutputPage } from "@fcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog.js";

/** One local page is retained; remote text is rendered as text, never markup or an action. */
export function RemoteExecutionOutputDialog(props: { workspaceKey: string; sessionId: string; record: RemoteExecutionRecord; onClose(): void }) {
  const client = usePlatform().remoteHosts; const { intl } = useFCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `remoteHosts.${key}` });
  const [page, setPage] = useState<RemoteExecutionOutputPage>(); const [error, setError] = useState(""); const [pending, setPending] = useState(false);
  const [cursor, setCursor] = useState<RemoteExecutionOutputCursor>(); const [previous, setPrevious] = useState<Array<RemoteExecutionOutputCursor | undefined>>([]);
  const generation = useRef(0); const busy = useRef(false); const refresh = useRef<(() => void) | undefined>(undefined);
  const load = async (next: RemoteExecutionOutputCursor | undefined, history: Array<RemoteExecutionOutputCursor | undefined>) => {
    if (!client || busy.current) return; const version = ++generation.current; busy.current = true; setPending(true); setError("");
    try {
      const value = await client.request("readExecutionOutput", { workspaceKey: props.workspaceKey, sessionId: props.sessionId,
        executionId: props.record.executionId, artifactId: props.record.outputArtifactId ?? remoteExecutionOutputArtifactId(props.record.executionId, props.record.attempt),
        ...(next ? { cursor: next } : {}), limit: 16 * 1024 });
      if (version === generation.current) {
        setPage(value);
        setCursor(value.available && value.version ? next ?? { artifactId: value.artifactId, version: value.version, byteOffset: 0, characterOffset: 0 } : undefined);
        setPrevious(value.expired || !value.available ? [] : history);
      }
    } catch (failure) { if (version === generation.current) setError(failure instanceof Error ? failure.message : t("requestFailed")); }
    finally { if (version === generation.current) { busy.current = false; setPending(false); } }
  };
  refresh.current = () => { void load(undefined, []); };
  useEffect(() => {
    refresh.current?.();
    return () => { generation.current++; busy.current = false; };
  }, [client, props.workspaceKey, props.sessionId, props.record.executionId]);
  const entries: RemoteExecutionOutputPage["entries"] = [];
  for (const entry of page?.entries ?? []) {
    const last = entries.at(-1);
    if (last?.stream === entry.stream) last.text += entry.text;
    else entries.push({ ...entry });
  }
  return <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl" aria-describedby={undefined} data-testid="remote-execution-output">
    <DialogHeader><DialogTitle>{t("localOutput")} · {props.record.display.name} · #{props.record.attempt}</DialogTitle></DialogHeader>
    {page?.available && <p className="break-all text-ui-sm">{intl.formatMessage({ id: "remoteHosts.localOutputSize" }, { bytes: page.fileBytes, page: previous.length + 1 })}</p>}
    {pending && <p role="status">{t("loading")}</p>}
    {error && <p role="alert" className="break-all text-destructive">{error}</p>}
    {page?.expired && <p>{t("outputExpired")}</p>}
    {page && !page.expired && !page.available && <p>{t("outputUnavailable")}</p>}
    {page?.available && !page.entries.length && <p>{t("outputPageEmpty")}</p>}
    {page?.maintenancePending && <p role="status" className="text-warning">{t("outputMaintenancePending")}</p>}
    {page?.incompleteTail && <p className="text-warning">{t("outputIncompleteTail")}</p>}
    {props.record.outputTruncated && <p className="text-ui-sm text-muted-foreground">{t("outputSavedRange")}</p>}
    <div className="max-h-[50vh] space-y-2 overflow-auto" data-testid="remote-execution-output-page">
      {entries.map((entry, index) => <div key={index} className="rounded border p-2">
        <p className={entry.stream === "stderr" ? "font-mono text-ui-xs text-warning" : "font-mono text-ui-xs text-muted-foreground"}>{entry.stream}</p>
        <pre className="whitespace-pre-wrap break-all font-mono text-ui-xs">{entry.text}</pre>
      </div>)}
    </div>
    <DialogFooter className="flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={pending} onClick={() => refresh.current?.()}>{t("refreshLocalOutput")}</Button>
      <Button type="button" variant="outline" disabled={pending || !previous.length} onClick={() => void load(previous.at(-1), previous.slice(0, -1))}>{t("previousOutputPage")}</Button>
      <Button type="button" variant="outline" disabled={pending || !page?.nextCursor} onClick={() => { if (page?.nextCursor) void load(page.nextCursor, [...previous, cursor]); }}>{t("nextOutputPage")}</Button>
      <Button type="button" onClick={props.onClose}>{t("done")}</Button>
    </DialogFooter>
  </DialogContent></Dialog>;
}
