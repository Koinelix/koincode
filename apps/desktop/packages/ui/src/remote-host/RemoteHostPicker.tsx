import { useRef, useState } from "react";
import { remoteEndpoint, type RemoteHostSummary, type RemoteUploadSource, type RemoteUploadSourcePreview } from "@fcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import { RemoteUploadSourcesPanel } from "./RemoteUploadSourcesPanel.js";

export function RemoteHostPicker(props: {
  open: boolean; applying: boolean; executionAvailable: boolean; onOpenChange(open: boolean): void; local: boolean; hosts: RemoteHostSummary[]; selected: RemoteHostSummary[];
  sources: RemoteUploadSource[]; pending: boolean; connecting?: boolean; prepareConnection?: boolean; error: string; pluginEnabled: boolean;
  savedSources: RemoteUploadSourcePreview[]; hasMoreSources: boolean;
  canCancelPreparation: boolean; cancelPreparationPending: boolean; onCancelPreparation(): Promise<void>;
  onConfirmSource(source: RemoteUploadSourcePreview): Promise<void>; onLoadMoreSources(): Promise<void>;
  onChange(hosts: RemoteHostSummary[]): void; onChoose(kind: "file" | "directory"): Promise<void>;
  onRemove(source: RemoteUploadSource): Promise<void>; onCapabilitySettings(): void;
  onApply(): Promise<void>; onManage(): void; onRefreshTargets(): Promise<void>; onCloseFocus(): void;
}) {
  const { intl } = useFCodeIntl(); const t = (key: string) => intl.formatMessage({ id: `remoteHosts.${key}` });
  const [query, setQuery] = useState(""); const [group, setGroup] = useState(""); const [environment, setEnvironment] = useState("");
  const composing = useRef(false); const restoreFocus = useRef(true); const list = useRef<HTMLDivElement>(null);
  const visible = props.hosts.filter((host) => (!group || host.config.group === group) && (!environment || host.config.environment === environment) &&
    [host.config.name, host.config.host, host.config.username, host.config.group, ...host.config.tags].join(" ").toLowerCase().includes(query.toLowerCase()));
  const selectable = (host: RemoteHostSummary) => props.executionAvailable && host.config.enabled && (props.prepareConnection || host.trustState === "trusted");
  const credentialReady = (host: RemoteHostSummary) => ["available", "session_only"].includes(host.credentialState);
  const toggle = (host: RemoteHostSummary) => props.onChange(props.selected.some((item) => item.hostId === host.hostId)
    ? props.selected.filter((item) => item.hostId !== host.hostId) : [...props.selected, host]);
  return <Dialog open={props.open} onOpenChange={(open) => { if (!props.applying) props.onOpenChange(open); }}><DialogContent
    className="max-h-[85vh] overflow-y-auto sm:max-w-3xl" aria-describedby={undefined} data-testid="remote-host-picker"
    onOpenAutoFocus={() => { restoreFocus.current = true; composing.current = false; }}
    onCloseAutoFocus={(event) => { event.preventDefault(); if (restoreFocus.current) props.onCloseFocus(); }}
    onCompositionStartCapture={() => { composing.current = true; }} onCompositionEndCapture={() => { composing.current = false; }}
    onEscapeKeyDown={(event) => { if (props.applying || composing.current || event.isComposing || event.keyCode === 229) event.preventDefault(); }}
    onInteractOutside={(event) => { if (props.applying) event.preventDefault(); }}
    onKeyDownCapture={(event) => {
      if (event.key !== "Enter") return;
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { event.preventDefault(); event.stopPropagation(); return; }
      if (event.target instanceof HTMLElement && event.target.closest("button, select, a")) return;
      event.preventDefault(); event.stopPropagation();
      if (!props.pending && props.local && props.executionAvailable && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) void props.onApply();
    }}>
    <DialogHeader><DialogTitle>{t("chooseTargets")}</DialogTitle></DialogHeader>
    {!props.local ? <p>{t("localOnly")}</p> : <>
      {!props.pluginEnabled && !props.pending && !props.error && <div className="space-y-2 rounded border p-3"><p>{t("capabilityUnavailable")}</p><Button type="button" onClick={() => { restoreFocus.current = false; props.onCapabilitySettings(); }}>{t("checkCapabilitySettings")}</Button></div>}
      <Input aria-label={t("search")} placeholder={t("search")} value={query} onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "ArrowDown" && !composing.current && !event.nativeEvent.isComposing) { event.preventDefault(); list.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus(); } }} />
      <div className="flex min-w-0 flex-wrap gap-2">
        <select aria-label={t("environment")} className="min-w-0 flex-1 rounded border p-2" value={environment} onChange={(event) => setEnvironment(event.target.value)}><option value="">{t("allEnvironments")}</option>
          {["unspecified", "development", "test", "production"].map((value) => <option key={value} value={value}>{t(`environment.${value}`)}</option>)}</select>
        <select aria-label={t("group")} className="min-w-0 flex-1 rounded border p-2" value={group} onChange={(event) => setGroup(event.target.value)}><option value="">{t("allGroups")}</option>
          {[...new Set(props.hosts.map((host) => host.config.group).filter(Boolean))].sort().map((value) => <option key={value}>{value}</option>)}</select>
      </div>
      <p role="status">{intl.formatMessage({ id: "remoteHosts.selectionCounts" }, { hosts: props.selected.length, sources: props.sources.length })}</p>
      <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={props.pending || !props.executionAvailable} onClick={() => props.onChange([...new Map([...props.selected, ...visible.filter(selectable)].map((host) => [host.hostId, host])).values()])}>{t("selectFiltered")}</Button>
        <Button type="button" variant="outline" disabled={props.pending} onClick={() => void props.onRefreshTargets()}>{t("refreshTargets")}</Button>
        <Button type="button" variant="outline" disabled={props.pending} onClick={() => { restoreFocus.current = false; props.onManage(); }}>{t("manageHosts")}</Button></div>
      {props.pending && <p role="status">{t(props.connecting ? "connecting" : "loading")}</p>}
      {!props.pending && !props.error && !visible.length && <p>{t(props.hosts.length ? "noMatchingHosts" : "noEnabledHosts")}</p>}
      <div ref={list} className="max-h-64 space-y-2 overflow-y-auto" onKeyDown={(event) => {
        if (!["ArrowUp", "ArrowDown"].includes(event.key) || composing.current || event.nativeEvent.isComposing) return;
        const inputs = [...event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not(:disabled)')];
        const index = inputs.indexOf(event.target as HTMLInputElement); if (index < 0) return;
        event.preventDefault(); event.stopPropagation(); inputs[(index + (event.key === "ArrowDown" ? 1 : -1) + inputs.length) % inputs.length]?.focus();
      }}>{visible.map((host) => <label key={host.hostId} className={`flex items-start gap-2 rounded border p-2 ${host.config.environment === "production" ? "border-destructive" : ""}`}>
        <input type="checkbox" disabled={props.pending || !selectable(host)} checked={props.selected.some((item) => item.hostId === host.hostId)} onChange={() => toggle(host)} />
        <span className="min-w-0 break-all"><strong>{host.config.name}</strong> · {host.config.username}@{remoteEndpoint(host.config)}<br />
          <span className={host.config.environment === "production" ? "font-semibold text-destructive" : ""}>{t(`environment.${host.config.environment}`)}</span> · {host.config.group} · {host.config.tags.join(", ")}
          {host.trustState !== "trusted" && <span className={props.prepareConnection ? "block text-warning" : "block text-destructive"}>{t(props.prepareConnection ? "connectTrustHint" : "trustRequired")}</span>}
          {selectable(host) && !credentialReady(host) && <span className="block text-warning">{t("credentialRequired")}</span>}</span></label>)}</div>
      <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={props.pending || !props.executionAvailable} onClick={() => void props.onChoose("file")}>{t("addUploadFile")}</Button><Button type="button" variant="outline" disabled={props.pending || !props.executionAvailable} onClick={() => void props.onChoose("directory")}>{t("addUploadDirectory")}</Button></div>
      <p className="text-ui-sm text-muted-foreground">{t("uploadIsolation")}</p>
      <RemoteUploadSourcesPanel sources={props.sources} savedSources={props.savedSources} pending={props.pending || !props.executionAvailable} hasMore={props.hasMoreSources}
        onConfirm={props.onConfirmSource} onRemove={props.onRemove} onLoadMore={props.onLoadMoreSources} />
    </>}
    {props.error && <div className="space-y-2"><p role="alert" className="break-all text-destructive">{props.error}</p>
      <Button type="button" variant="outline" disabled={props.pending} onClick={() => void props.onRefreshTargets()}>{t("refresh")}</Button></div>}
    <DialogFooter>{props.canCancelPreparation && <Button type="button" variant="outline" disabled={props.cancelPreparationPending}
      onClick={() => void props.onCancelPreparation()}>{t(props.cancelPreparationPending ? "cancelPreparationPending" : "cancelPreparation")}</Button>}
      <Button type="button" variant="outline" disabled={props.applying} onClick={() => props.onOpenChange(false)}>{t("cancel")}</Button>
      <Button type="button" disabled={props.pending || !props.local || !props.executionAvailable} onClick={() => void props.onApply()}>{t("applySelection")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
