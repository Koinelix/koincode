import { useEffect, useRef, useState } from "react";
import type { RemoteExecutionRecord } from "@fcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { RemoteHostReconciliationButton } from "./RemoteHostReconciliationButton.js";
import { RemoteExecutionOutputDialog } from "./RemoteExecutionOutputDialog.js";

const ACTIVE = new Set(["queued", "dispatching", "running", "verifying", "cancel_requested"]);
const REFRESH_MS = 1500;
export function RemoteHostExecutionPanel({ workspaceKey, sessionId, observing, onRetry }: { workspaceKey: string; sessionId: string; observing: boolean;
  onRetry?(records: RemoteExecutionRecord[]): void | Promise<void> }) {
  const client = usePlatform().remoteHosts; const { intl } = useFCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `remoteHosts.${key}` });
  const [records, setRecords] = useState<RemoteExecutionRecord[]>([]); const [cursor, setCursor] = useState<string>();
  const [error, setError] = useState(""); const [pending, setPending] = useState(false);
  const [retryIds, setRetryIds] = useState<Set<string>>(new Set());
  const [output, setOutput] = useState<RemoteExecutionRecord>(); const [maintenancePending, setMaintenancePending] = useState(false);
  const retryable = records.filter((record) => ["failed", "canceled", "needs_review"].includes(record.state));
  const retryRecords = retryable.filter((record) => retryIds.has(record.executionId));
  const generation = useRef(0);
  const observingRef = useRef(observing); observingRef.current = observing;
  const previousObserving = useRef(observing);
  const refreshRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    const version = ++generation.current; let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false; let refreshAgain = false;
    const refresh = async () => {
      if (!client || version !== generation.current) return;
      clearTimeout(timer);
      if (refreshing) { refreshAgain = true; return; }
      refreshing = true;
      try {
        const page = await client.request("listExecutions", { workspaceKey, sessionId, limit: 50 });
        if (version !== generation.current) return;
        setRecords(page.items); setCursor(page.nextCursor); setError("");
        setMaintenancePending(page.maintenancePending ?? false);
        if ((observingRef.current && page.liveRemoteTurn) || page.items.some((record) => ACTIVE.has(record.state))) timer = setTimeout(() => { void refresh(); }, REFRESH_MS);
      } catch (failure) { if (version === generation.current) setError(failure instanceof Error ? failure.message : "Remote execution history is unavailable."); }
      finally { refreshing = false; if (refreshAgain && version === generation.current) { refreshAgain = false; void refresh(); } }
    };
    refreshRef.current = () => { void refresh(); };
    setRecords([]); setCursor(undefined); setRetryIds(new Set()); setPending(false); setOutput(undefined); setMaintenancePending(false); void refresh();
    return () => { generation.current++; clearTimeout(timer); refreshRef.current = undefined; };
  }, [client, sessionId, workspaceKey]);
  useEffect(() => {
    if (previousObserving.current !== observing) { previousObserving.current = observing; refreshRef.current?.(); }
  }, [observing]);
  const loadMore = async () => {
    if (!client || !cursor || pending) return; const version = generation.current; setPending(true);
    try {
      const page = await client.request("listExecutions", { workspaceKey, sessionId, cursor, limit: 50 });
      if (version === generation.current) { setRecords((previous) => [...previous, ...page.items.filter((item) => !previous.some((old) => old.executionId === item.executionId))]); setCursor(page.nextCursor); }
    } catch (failure) { if (version === generation.current) setError(failure instanceof Error ? failure.message : t("requestFailed")); }
    finally { if (version === generation.current) setPending(false); }
  };
  if (!records.length && !error) return null;
  return <details className="mx-3 mt-2 rounded border p-2" data-testid="remote-host-executions">
    <summary className="cursor-pointer text-ui-sm font-medium">{t("executionHistory")} ({records.length})</summary>
    <div className="mt-2 max-h-80 space-y-2 overflow-y-auto">
      {records.map((record) => <div key={record.executionId} className="space-y-1 rounded border p-2 text-ui-sm">
        <p className="break-all"><strong>{record.display.name}</strong> · {record.display.username}@{record.display.endpoint} · {record.operation}</p>
        <p>{t(`state.${record.state}`)} · #{record.attempt} {record.exitCode !== undefined ? `· exit ${record.exitCode}` : ""} {record.signal ? `· ${record.signal}` : ""}</p>
        {record.retryOf && <p className="break-all text-ui-xs">{t("retryOf")}: {record.retryOf.executionId} · #{record.retryOf.attempt}</p>}
        {onRetry && retryable.includes(record) && <label className="flex items-center gap-2"><input type="checkbox" disabled={pending}
          checked={retryIds.has(record.executionId)} aria-label={`${t("selectRetry")} ${record.display.name} #${record.attempt}`}
          onChange={(event) => setRetryIds((previous) => {
            const next = new Set([...previous].filter((id) => !records.some((item) => item.executionId === id && item.hostId === record.hostId)));
            if (event.target.checked) next.add(record.executionId); return next;
          })} />{t("selectRetry")}</label>}
        {record.remotePath && <p className="break-all font-mono">{record.remotePath}</p>}
        {record.manifestHash && <p className="break-all font-mono text-ui-xs">SHA-256 manifest {record.manifestHash}</p>}
        {record.uploadedBytes !== undefined && <p>{record.uploadedBytes} B · {record.uploadedFiles ?? 0} files</p>}
        {record.verification && <p>{t("verification")}: {record.verification}</p>}
        {record.error && <p className="break-all text-destructive">{record.error.code}: {record.error.message}</p>}
        {record.reconciliation && <details><summary>{t("reconciliationResult")}</summary><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all text-ui-xs">{JSON.stringify(record.reconciliation, null, 2)}</pre></details>}
        {record.result && record.outputExpiredAt === undefined && <details><summary>{t("resultDetails")}</summary><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-ui-xs">{typeof record.result.summary === "string" ? record.result.summary : JSON.stringify(record.result, null, 2)}</pre></details>}
        {record.outputExpiredAt !== undefined && <p>{t("outputExpired")}</p>}
        {record.operation === "exec" && (record.startedAt !== undefined || record.outputArtifactId) && <Button type="button" size="sm" variant="outline"
          data-testid={`remote-output-open-${record.executionId}`} onClick={() => setOutput(record)}>{t("viewLocalOutput")}</Button>}
        {record.outputTruncated && <p>{t("outputTruncated")}</p>}
        {!!record.residualPaths?.length && <details><summary>{t("residualPaths")}</summary><pre className="whitespace-pre-wrap break-all text-ui-xs">{record.residualPaths.join("\n")}</pre></details>}
        {["execution_unknown", "needs_review"].includes(record.state) && <RemoteHostReconciliationButton
          key={`${workspaceKey}:${sessionId}:${record.executionId}`} record={record} workspaceKey={workspaceKey} sessionId={sessionId}
          onResult={(updated) => setRecords((previous) => previous.map((item) => item.executionId === updated.executionId ? updated : item))} />}
        {ACTIVE.has(record.state) && <Button type="button" variant="outline" size="sm" disabled={pending} onClick={async () => {
          if (!client) return; const version = generation.current; setPending(true);
          try {
            const updated = await client.request("cancelExecution", { requestId: crypto.randomUUID(), workspaceKey, sessionId, executionIds: [record.executionId] });
            if (version === generation.current) setRecords((previous) => previous.map((item) => updated.find((next) => next.executionId === item.executionId) ?? item));
          } catch (failure) { if (version === generation.current) setError(failure instanceof Error ? failure.message : t("requestFailed")); }
          finally { if (version === generation.current) setPending(false); }
        }}>{t("cancelExecution")}</Button>}
      </div>)}
      {cursor && <Button type="button" variant="outline" disabled={pending} onClick={() => void loadMore()}>{t("loadMore")}</Button>}
      {onRetry && !!retryable.length && <Button type="button" variant="outline" disabled={pending || !retryRecords.length} onClick={async () => {
        const version = generation.current; setPending(true); setError("");
        try { await onRetry(structuredClone(retryRecords)); if (version === generation.current) setRetryIds(new Set()); }
        catch (failure) { if (version === generation.current) setError(failure instanceof Error ? failure.message : t("requestFailed")); }
        finally { if (version === generation.current) setPending(false); }
      }}>{t("prepareRetry")} ({retryRecords.length})</Button>}
      {error && <p role="alert" className="break-all text-destructive">{error}</p>}
      {maintenancePending && <p role="status" className="text-warning">{t("outputMaintenancePending")}</p>}
    </div>
    {output && <RemoteExecutionOutputDialog key={`${workspaceKey}:${sessionId}:${output.executionId}`} record={output} workspaceKey={workspaceKey} sessionId={sessionId} onClose={() => setOutput(undefined)} />}
  </details>;
}
