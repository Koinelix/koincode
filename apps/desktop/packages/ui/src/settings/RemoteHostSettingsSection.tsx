import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Plus, RefreshCw, Server } from "lucide-react";
import { remoteEndpoint, REMOTE_HOST_LIMITS, type RemoteHostCapabilities, type RemoteHostSummary, type RemoteTestResult } from "@fcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import { RemoteHostForm } from "./RemoteHostForm.js";
import { useRemoteHostConnection } from "@/remote-host/useRemoteHostConnection.js";
import { useRemoteManagementOperation } from "@/remote-host/useRemoteManagementOperation.js";
import { shouldPrepareRemoteHostConnection } from "@/remote-host/connectionPlatform.js";
import { RemoteHostTrustDialog } from "./RemoteHostTrustDialog.js";

export function RemoteHostSettingsSection() {
  const { intl } = useFCodeIntl();
  const client = usePlatform().remoteHosts;
  const connection = useRemoteHostConnection(client, "settings-connection-tests");
  const connectionTest = useRemoteManagementOperation(client, "settings-legacy-connection-tests");
  const prepareConnection = shouldPrepareRemoteHostConnection();
  const t = (key: string) => intl.formatMessage({ id: `remoteHosts.${key}` });
  const [capabilities, setCapabilities] = useState<RemoteHostCapabilities | null>(null);
  const [hosts, setHosts] = useState<RemoteHostSummary[]>([]);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<RemoteHostSummary | "new" | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [results, setResults] = useState<Map<string, RemoteTestResult>>(new Map());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const [batchTargets, setBatchTargets] = useState<RemoteHostSummary[]>([]);
  const [labelGroup, setLabelGroup] = useState("");
  const [labelTags, setLabelTags] = useState("");
  const [replaceTags, setReplaceTags] = useState(false);
  const [replaceGroup, setReplaceGroup] = useState(false);
  const generation = useRef(0);
  const groups = [...new Set(hosts.map((host) => host.config.group).filter(Boolean))].sort();
  const chosen = hosts.filter((host) => selected.has(host.hostId));
  const challengeResult = !prepareConnection ? [...results.values()].find((result) => result.challenge) : undefined;

  const refresh = useCallback(async () => {
    if (!client) { setLoading(false); return; }
    const current = ++generation.current;
    setLoading(true);
    try {
      const [page, capability] = await Promise.all([
        client.request("listHosts", { query, ...(group ? { group } : {}), limit: REMOTE_HOST_LIMITS.maxPageSize }),
        client.request("getCapabilities", {}),
      ]);
      if (current !== generation.current) return;
      setHosts(page.items); setCapabilities(capability); setSelected(new Set()); setError("");
    } catch (failure) { if (current === generation.current) setError(failure instanceof Error ? failure.message : "Remote Host request failed."); }
    finally { if (current === generation.current) setLoading(false); }
  }, [client, group, query]);
  useEffect(() => {
    const timer = setTimeout(() => { void refresh(); }, 150);
    return () => { clearTimeout(timer); generation.current++; };
  }, [refresh]);

  const run = async (action: () => Promise<void>) => {
    setPending(true); setError("");
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : t("requestFailed")); }
    finally { setPending(false); }
  };
  const targets = (items: RemoteHostSummary[]) => items.map((host) => ({ hostId: host.hostId, expectedRevision: host.revision }));
  const updateSelected = async (patch: { enabled?: boolean; group?: string; tags?: string[] }, items = chosen) => {
    if (!client) return;
    const values = await client.request("updateHosts", { requestId: crypto.randomUUID(), targets: targets(items), patch });
    await refresh();
    const failed = values.filter((value) => !value.success);
    if (failed.length) setError(failed.map((value) => value.error?.message).join("; "));
  };
  const test = async (items: RemoteHostSummary[]) => {
    if (!client) return;
    if (!prepareConnection) {
      const values = await connectionTest.run("testConnections", { targets: items.map((host) => ({ hostId: host.hostId, securityRevision: host.securityRevision })) });
      setResults((previous) => { const next = new Map(previous); for (const result of values) next.set(result.hostId, result); return next; });
      await refresh(); return;
    }
    try {
      const values = await connection.run(items);
      setResults((previous) => { const next = new Map(previous); for (const host of values) next.set(host.hostId, { hostId: host.hostId, success: true, checkedAt: Date.now() }); return next; });
    } finally { await refresh(); }
  };
  if (!client) return <p className="text-ui-base text-foreground-subtlest">{t("desktopRequired")}</p>;
  return <div className="space-y-5" data-testid="remote-host-settings">
    <p className="max-w-3xl text-ui-base text-foreground-subtlest">{t("description")}</p>
    {capabilities && !capabilities.executionAvailable && <p role="alert" className="text-ui-base text-warning">{t(`runtimeUnavailable.${capabilities.executionUnavailableReason ?? "platform_unverified"}`)}</p>}
    {connection.busy && <p role="status" className="text-ui-base">{t("connecting")} <Button variant="outline" onClick={() => {
      void connection.cancel().catch((failure) => setError(failure instanceof Error ? failure.message : t("requestFailed")));
    }}>{t("cancel")}</Button></p>}
    <div className="flex flex-wrap items-center gap-2">
      <Input className="min-w-40 flex-1" aria-label={t("search")} placeholder={t("search")} value={query} onChange={(event) => setQuery(event.target.value)} />
      <select aria-label={t("group")} className="h-8 rounded-md border border-input-border bg-input px-2 text-ui-base" value={group} onChange={(event) => setGroup(event.target.value)}>
        <option value="">{t("allGroups")}</option>{[...new Set([...groups, ...(group ? [group] : [])])].map((value) => <option key={value}>{value}</option>)}
      </select>
      <Button variant="outline" aria-label={t("refresh")} disabled={pending || loading} onClick={() => { void refresh(); }}><RefreshCw className="size-4" /></Button>
      <Button disabled={pending || !capabilities} onClick={() => setForm("new")}><Plus className="size-4" />{t("add")}</Button>
    </div>
    {error ? <p role="alert" className="break-words text-ui-base text-destructive">{error}</p> : null}
    {loading ? <div role="status" className="flex gap-2 text-foreground-subtlest"><LoaderCircle className="size-4 animate-spin" />{t("loading")}</div> : null}
    <div className="flex flex-wrap items-center gap-3 text-ui-base">
      <label className="flex items-center gap-2"><input type="checkbox" checked={hosts.length > 0 && chosen.length === hosts.length} disabled={!hosts.length || pending}
        onChange={(event) => setSelected(new Set(event.target.checked ? hosts.map((host) => host.hostId) : []))} />{t("selectFiltered")}</label>
      <span className="text-foreground-subtlest">{chosen.length} / {hosts.length}</span>
      <Button size="sm" variant="outline" disabled={!chosen.length || pending} onClick={() => { void run(() => test(chosen)); }}>{t("test")}</Button>
      {connectionTest.active && <Button size="sm" variant="outline" disabled={connectionTest.cancelRequested}
        onClick={() => void connectionTest.cancel().catch((failure) => setError(failure instanceof Error ? failure.message : t("requestFailed")))}>
        {t(connectionTest.cancelRequested ? "cancelPreparationPending" : "cancelConnectionTest")}</Button>}
      <Button size="sm" variant="outline" disabled={!chosen.length || pending} onClick={() => { void run(() => updateSelected({ enabled: true })); }}>{t("enable")}</Button>
      <Button size="sm" variant="outline" disabled={!chosen.length || pending} onClick={() => { void run(() => updateSelected({ enabled: false })); }}>{t("disable")}</Button>
      <Button size="sm" variant="outline" disabled={!chosen.length || pending} onClick={() => { setBatchTargets(structuredClone(chosen)); setLabelGroup(""); setLabelTags(""); setReplaceTags(false); setReplaceGroup(false); setLabelOpen(true); }}>{t("labels")}</Button>
      <Button size="sm" variant="outline" disabled={!chosen.length || pending} onClick={() => { setBatchTargets(structuredClone(chosen)); setDeleteOpen(true); }}>{t("delete")}</Button>
    </div>
    <div className="divide-y divide-border rounded-lg border border-border">
      {!hosts.length && !loading ? <div className="flex items-center gap-3 p-6 text-foreground-subtlest"><Server className="size-5" />{t("empty")}</div> : null}
      {hosts.map((host) => <div key={host.hostId} className="flex flex-wrap items-center gap-3 p-3">
        <input type="checkbox" aria-label={host.config.name} checked={selected.has(host.hostId)} disabled={pending} onChange={(event) => setSelected((old) => {
          const next = new Set(old); if (event.target.checked) next.add(host.hostId); else next.delete(host.hostId); return next;
        })} />
        <div className="min-w-36 flex-1 space-y-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-ui-base">{host.config.name}</strong>
          <span className={host.config.environment === "production" ? "text-ui-sm text-destructive" : "text-ui-sm text-foreground-subtlest"}>{t(`environment.${host.config.environment}`)}</span>
          {!host.config.enabled ? <span className="text-ui-sm text-foreground-subtlest">{t("disabled")}</span> : null}</div>
          <p className="break-all font-mono text-ui-sm text-foreground-subtlest">{host.config.username}@{remoteEndpoint(host.config)}</p>
          <p className="text-ui-sm text-foreground-subtlest">{[host.config.group, host.config.tags.join(", "), t(`credential.${host.credentialState}`), t(`trustState.${host.trustState}`)].filter(Boolean).join(" · ")}</p>
          {results.get(host.hostId) ? <p className={results.get(host.hostId)!.success ? "text-ui-sm text-foreground-subtlest" : "text-ui-sm text-destructive"}>
            {results.get(host.hostId)!.success ? t("testSucceeded") : results.get(host.hostId)!.error?.message}</p> : null}
        </div>
        <Button variant="outline" size="sm" disabled={pending} onClick={() => { void run(() => test([host])); }}>{t("test")}</Button>
        <Button variant="outline" size="sm" disabled={pending} onClick={() => setForm(host)}>{t("edit")}</Button>
      </div>)}
    </div>
    {form ? <RemoteHostForm key={form === "new" ? "new" : form.hostId} host={form === "new" ? undefined : form} client={client} capabilities={capabilities}
      onClose={() => setForm(null)} onSaved={(saved) => { setResults(new Map());
        if (prepareConnection && saved.config.enabled && capabilities?.executionAvailable) void run(() => test([saved])); else void refresh(); }} /> : null}
    {connection.dialog}
    {challengeResult?.challenge ? <RemoteHostTrustDialog challenge={challengeResult.challenge} changed={challengeResult.error?.code === "host_key_changed"} pending={pending}
      onClose={() => setResults((old) => { const next = new Map(old); next.delete(challengeResult.hostId); return next; })}
      onAccept={() => { void run(async () => {
        await client.request("acceptHostKey", { challengeId: challengeResult.challenge!.challengeId,
          action: challengeResult.error?.code === "host_key_changed" ? "replace_changed_key" : "trust_initial" });
        setResults((old) => { const next = new Map(old); next.delete(challengeResult.hostId); return next; }); await refresh();
      }); }} /> : null}
    <Dialog open={deleteOpen} onOpenChange={(open) => { if (!pending) setDeleteOpen(open); }}><DialogContent aria-describedby="remote-host-delete-description"><DialogHeader><DialogTitle>{t("delete")}: {batchTargets.length}</DialogTitle></DialogHeader>
      <p id="remote-host-delete-description" className="text-ui-base text-foreground-subtlest">{t("deleteHelp")}</p><p className="break-words text-ui-base">{batchTargets.map((host) => `${host.config.name} · ${host.config.username}@${remoteEndpoint(host.config)}`).join(", ")}</p>
      <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setDeleteOpen(false)}>{t("cancel")}</Button><Button variant="destructive" disabled={pending || !batchTargets.length} onClick={() => { void run(async () => {
        const values = await client.request("deleteHosts", { requestId: crypto.randomUUID(), targets: targets(batchTargets) }); setDeleteOpen(false); await refresh();
        if (values.some((value) => !value.success)) setError(values.filter((value) => !value.success).map((value) => value.error?.message).join("; "));
      }); }}>{t("delete")}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={labelOpen} onOpenChange={(open) => { if (!pending) setLabelOpen(open); }}><DialogContent aria-describedby={undefined}><DialogHeader><DialogTitle>{t("labels")}: {batchTargets.length}</DialogTitle></DialogHeader>
      <p className="break-words text-ui-base">{batchTargets.map((host) => `${host.config.name} · ${host.config.username}@${remoteEndpoint(host.config)}`).join(", ")}</p>
      <label className="flex gap-2 text-ui-base"><input type="checkbox" checked={replaceGroup} onChange={(event) => setReplaceGroup(event.target.checked)} />{t("replaceGroup")}</label>
      {replaceGroup ? <Input aria-label={t("group")} value={labelGroup} onChange={(event) => setLabelGroup(event.target.value)} /> : null}
      <label className="flex gap-2 text-ui-base"><input type="checkbox" checked={replaceTags} onChange={(event) => setReplaceTags(event.target.checked)} />{t("replaceTags")}</label>
      {replaceTags ? <Input aria-label={t("tags")} value={labelTags} onChange={(event) => setLabelTags(event.target.value)} /> : null}
      <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setLabelOpen(false)}>{t("cancel")}</Button><Button disabled={pending || !batchTargets.length || !replaceGroup && !replaceTags} onClick={() => { void run(async () => {
        await updateSelected({ ...(replaceGroup ? { group: labelGroup } : {}), ...(replaceTags ? { tags: labelTags.split(",").map((value) => value.trim()).filter(Boolean) } : {}) }, batchTargets); setLabelOpen(false);
      }); }}>{t("save")}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
