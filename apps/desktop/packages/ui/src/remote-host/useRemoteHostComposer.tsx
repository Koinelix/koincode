import { RemoteHostAuthorizationStatus } from "./RemoteHostAuthorizationStatus.js";
import { useCallback, useRef, useState } from "react";
import { X } from "lucide-react";
import { isCompatibleRemoteHostPlugin, remoteEndpoint, type RemoteHostSummary, type RemoteUploadSource, type RemoteUploadSourcePreview, type RemoteHostComposerSelection, type RemoteExecutionRecord } from "@fcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import { RemoteHostPicker } from "./RemoteHostPicker.js";
import { useRemoteUploadIntents } from "./useRemoteUploadIntents.js";
import { useRemoteManagementOperation } from "./useRemoteManagementOperation.js";
import { useRemoteHostConnection } from "./useRemoteHostConnection.js";
import { shouldPrepareRemoteHostConnection } from "./connectionPlatform.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";

interface DraftState {
  key: string; draftId: string; active: boolean; open: boolean; pending: boolean; error: string; pluginEnabled: boolean;
  hosts: RemoteHostSummary[]; sources: RemoteUploadSource[]; available: RemoteHostSummary[];
  savedSources: RemoteUploadSourcePreview[]; sourceCursor?: string;
  promotionSessionId?: string;
  executionAvailable: boolean;
  pickerId: string; applying: boolean; pickerHosts: RemoteHostSummary[]; pickerSources: RemoteUploadSource[]; removedSources: RemoteUploadSource[];
}
function emptyDraft(key: string): DraftState {
  return { key, draftId: crypto.randomUUID(), active: false, open: false, pending: false, error: "", pluginEnabled: false, hosts: [], sources: [], savedSources: [], available: [],
    pickerId: crypto.randomUUID(), applying: false, executionAvailable: false, pickerHosts: [], pickerSources: [], removedSources: [] };
}
export function useRemoteHostComposer(context: { workspacePath: string; workspaceIdentity?: string; remoteSessionId?: string | null; sessionId?: string | null;
  draftFocusVersion: number;
  onModelFiles(files: File[]): void; clearDragFeedback(): void; focusInput(): void }) {
  const platform = usePlatform(); const services = useOptionalServices(); const { intl } = useFCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `remoteHosts.${key}` });
  const key = JSON.stringify([context.workspacePath, context.sessionId ?? null, context.workspaceIdentity ?? null, context.remoteSessionId ?? null, context.draftFocusVersion]);
  const [draft, setDraft] = useState<DraftState>(() => emptyDraft(key));
  const promoted = Boolean(context.sessionId && draft.promotionSessionId === context.sessionId &&
    draft.key === JSON.stringify([context.workspacePath, null, context.workspaceIdentity ?? null, context.remoteSessionId ?? null, context.draftFocusVersion]));
  const current = draft.key === key ? draft : promoted ? { ...draft, key, open: false, pending: false, error: "", promotionSessionId: undefined, savedSources: [], sourceCursor: undefined } : emptyDraft(key);
  if (draft.key !== key) setDraft(current);
  const currentRef = useRef(current); currentRef.current = current;
  const client = platform.remoteHosts;
  const operationKey = `${current.key}:${current.draftId}:${current.open ? current.pickerId : "closed"}`;
  const sourceConfirmation = useRemoteManagementOperation(client, operationKey);
  const connection = useRemoteHostConnection(client, operationKey);
  const prepareConnection = shouldPrepareRemoteHostConnection();
  const openSettings = useOptionalTabStore((state) => state.openSettingsTab);
  const local = Boolean(client && !context.workspaceIdentity && !context.remoteSessionId);
  const binding = context.sessionId ? { kind: "session" as const, sessionId: context.sessionId } : { kind: "draft" as const, draftId: current.draftId };
  const update = (snapshot: DraftState, patch: Partial<DraftState>) => setDraft((previous) => previous.key === snapshot.key && previous.draftId === snapshot.draftId ? { ...previous, ...patch } : previous);
  const updatePicker = (snapshot: DraftState, patch: Partial<DraftState>) => setDraft((previous) => previous.key === snapshot.key && previous.draftId === snapshot.draftId &&
    previous.open && previous.pickerId === snapshot.pickerId ? { ...previous, ...patch } : previous);
  const dismissPicker = () => { if (!current.applying) update(current, { open: false, pending: false, pickerId: crypto.randomUUID(), pickerHosts: [], pickerSources: [], removedSources: [] }); };
  const readPluginEnabled = async () => {
    const service = services?.pluginManagementService;
    if (!service) throw new Error(t("capabilityStatusUnavailable"));
    // Read this workspace directly; a shared store can hide errors or contain another workspace.
    const catalog = await service.listPlugins({ workspacePath: context.workspacePath });
    return catalog.plugins.some(isCompatibleRemoteHostPlugin);
  };
  const show = useCallback(async () => {
    const previous = currentRef.current;
    const captured = { ...previous, active: true, open: true, pending: true, error: "", pickerId: crypto.randomUUID(),
      applying: false, pluginEnabled: false, executionAvailable: false, pickerHosts: [...previous.hosts], pickerSources: [...previous.sources], removedSources: [] };
    update(previous, captured);
    if (!local || !client) { updatePicker(captured, { pending: false, error: t("localOnly") }); return; }
    try {
      const sourceBinding = context.sessionId ? { kind: "session" as const, sessionId: context.sessionId } : { kind: "draft" as const, draftId: captured.draftId };
      const [page, sources, capabilities, pluginEnabled] = await Promise.all([client.request("listHosts", { enabled: true, limit: 200 }),
        client.request("listUploadSources", { workspaceKey: context.workspacePath, binding: sourceBinding, limit: 50 }), client.request("getCapabilities", {}), readPluginEnabled()]);
      updatePicker(captured, { available: page.items, savedSources: sources.items, sourceCursor: sources.nextCursor, pluginEnabled, executionAvailable: capabilities.executionAvailable && pluginEnabled,
        error: capabilities.executionAvailable ? "" : t(`runtimeUnavailable.${capabilities.executionUnavailableReason ?? "platform_unverified"}`) });
    } catch (failure) { updatePicker(captured, { error: failure instanceof Error ? failure.message : t("requestFailed") }); }
    finally { updatePicker(captured, { pending: false }); }
  }, [client, context.workspacePath, context.sessionId, local, services, intl]);
  const close = () => {
    // A new draft identity invalidates late UI requests without revoking accepted broker permits.
    setDraft(emptyDraft(key));
    context.focusInput();
  };
  const upload = useRemoteUploadIntents({ key: `${current.key}:${current.draftId}`, operationKey, enabled: local && current.active && current.executionAvailable,
    managementPending: current.pending, workspaceKey: context.workspacePath, binding, onModelFiles: context.onModelFiles,
    clearDragFeedback: context.clearDragFeedback, onSources: (sources) => {
      const existing = current.open ? current.pickerSources : current.sources;
      const merged = [...existing, ...sources.filter((source) => !existing.some((item) => item.sourceId === source.sourceId))];
      if (current.open) updatePicker(current, { pickerSources: merged }); else update(current, { sources: merged });
    } });
  const snapshot = (): RemoteHostComposerSelection | undefined => {
    if (current.open || current.pending || upload.blocked) throw new Error(t("uploadIntentUnresolved"));
    if (current.hosts.length && !current.executionAvailable) throw new Error(t("runtimeUnavailable.platform_unverified"));
    if (local && current.active && current.sources.length && !current.hosts.length) throw new Error(t("uploadTargetsRequired"));
    return local && current.active && current.hosts.length ? {
    workspaceKey: context.workspacePath, binding: { ...binding },
    targets: current.hosts.map((host) => ({ hostId: host.hostId, securityRevision: host.securityRevision, trustRevision: host.trustRevision })),
    sourceIds: current.sources.map((source) => source.sourceId),
    } : undefined;
  };
  const command: AppSlashCommand = { value: "remote-host", description: t("chooseTargets"), trustedUiAction: "remote-host-picker", run: () => { void show(); } };
  const prepareRetry = (records: RemoteExecutionRecord[]): string => {
    if (!local || !current.active || !records.length) throw new Error(t("retryUnavailable"));
    const targets = records.map((record) => {
      const host = current.available.find((host) => host.hostId === record.hostId);
      if (!host || !host.config.enabled || host.trustState !== "trusted" || !["available", "session_only"].includes(host.credentialState) ||
        remoteEndpoint(host.config) !== record.display.endpoint || host.config.username !== record.display.username ||
        !["failed", "canceled", "needs_review"].includes(record.state)) throw new Error(t("retryTargetChanged"));
      return host;
    });
    if (new Set(targets.map((host) => host.hostId)).size !== targets.length) throw new Error(t("retryOnePerHost"));
    update(current, { hosts: targets, error: "" });
    return intl.formatMessage({ id: "remoteHosts.retryPrompt" }, { records: records.map((record) =>
      `${record.display.name} · ${record.display.username}@${record.display.endpoint} · ${record.operation}\nretryOf: ${JSON.stringify({ executionId: record.executionId, attempt: record.attempt })} · hostId: ${record.hostId}`).join("\n\n") });
  };
  return {
    command, open: show, snapshot, prepareRetry, active: local && current.active,
    uploadBlocked: current.open || current.pending || upload.blocked || Boolean(local && current.active && current.sources.length && !current.hosts.length), canAddUpload: upload.canAdd, chooseUpload: upload.choose,
    addUploadPaths: (paths: string[], beforeFreeze?: () => void) => upload.addPaths(paths, [], beforeFreeze), offerUploadDrop: upload.offerDrop,
    accepted: (sessionId: string) => { if (binding.kind === "draft") update(current, { promotionSessionId: sessionId }); },
    targetBar: <>{local && current.active ? <div {...upload.dropHandlers} className="flex flex-wrap items-center gap-2 px-3 pt-2 text-ui-sm" data-testid="remote-host-target-bar">
      <button type="button" disabled={current.pending || upload.pending} onClick={() => void show()} className="rounded border px-2 py-1">{t("chooseTargets")}{current.hosts.length ? ` (${current.hosts.length})` : ""}</button>
      <span>{intl.formatMessage({ id: "remoteHosts.selectionCounts" }, { hosts: current.hosts.length, sources: current.sources.length })}</span>
      {current.hosts.map((host) => <span key={host.hostId} className={`max-w-full break-all rounded px-2 py-1 ${host.config.environment === "production" ? "border border-destructive text-destructive" : "bg-muted"}`}>{host.config.name} · {host.config.username}@{remoteEndpoint(host.config)} · {t(`environment.${host.config.environment}`)}</span>)}
      {current.sources.map((source) => <span key={source.sourceId} className="max-w-full break-all rounded border px-2 py-1" data-purpose="remote_upload">{source.displayName} · {source.totalBytes} B · SHA-256 {source.manifestHash.slice(0, 12)}</span>)}
      {!!(current.hosts.length || current.sources.length) && <button type="button" disabled={current.pending || upload.pending} className="rounded border px-2 py-1"
        onClick={() => { update(current, { hosts: [], sources: [] }); context.focusInput(); }}>{t("clearSelection")}</button>}
      <button type="button" aria-label={t("closeMode")} title={t("closeMode")} onClick={close} className="ml-auto rounded p-1 hover:bg-muted" data-testid="remote-host-close"><X className="size-4" aria-hidden /></button>
      {upload.status}
      {!current.open && !current.executionAvailable && current.error && <p role="alert" className="w-full text-warning">{current.error}</p>}
      {!!current.sources.length && !current.hosts.length && <p role="alert" className="w-full text-warning">{t("uploadTargetsRequired")}</p>}
    </div> : null}
      {local && client && context.sessionId && <RemoteHostAuthorizationStatus key={`${context.workspacePath}:${context.sessionId}`}
        client={client} workspaceKey={context.workspacePath} sessionId={context.sessionId} />}
    </>,
    picker: <><RemoteHostPicker open={current.active && current.open} applying={current.applying} executionAvailable={current.executionAvailable} onOpenChange={(open) => { if (!open) dismissPicker(); }} local={local} hosts={current.available} selected={current.pickerHosts} sources={current.pickerSources}
      onCloseFocus={context.focusInput} onManage={() => { dismissPicker(); setPendingSettingsSectionIntent("remoteHosts"); openSettings(); }}
      onCapabilitySettings={() => { dismissPicker(); setPendingSettingsSectionIntent("plugin"); openSettings(); }}
      onRefreshTargets={async () => {
        if (!client || current.pending) return; const captured = current; updatePicker(captured, { pending: true, error: "", pluginEnabled: false, executionAvailable: false });
        try {
          const [page, sourcePage, capabilities, pluginEnabled] = await Promise.all([client.request("listHosts", { enabled: true, limit: 200 }),
            client.request("listUploadSources", { workspaceKey: context.workspacePath, binding, limit: 50 }), client.request("getCapabilities", {}), readPluginEnabled()]);
          updatePicker(captured, { available: page.items, savedSources: sourcePage.items, sourceCursor: sourcePage.nextCursor, pluginEnabled,
            executionAvailable: capabilities.executionAvailable && pluginEnabled, error: capabilities.executionAvailable ? "" : t(`runtimeUnavailable.${capabilities.executionUnavailableReason ?? "platform_unverified"}`),
            pickerHosts: page.items.filter((host) => host.config.enabled && (prepareConnection || host.trustState === "trusted") && captured.pickerHosts.some((item) => item.hostId === host.hostId)) });
        } catch (failure) { updatePicker(captured, { error: failure instanceof Error ? failure.message : t("requestFailed") }); }
        finally { updatePicker(captured, { pending: false }); }
      }}
      onApply={async () => {
        if (!client || current.pending || upload.pending || !current.executionAvailable) return; const captured = current; const removed = new Set<string>();
        updatePicker(captured, { pending: true, applying: true, error: "" });
        try {
          const hosts = prepareConnection ? await connection.run(captured.pickerHosts) : captured.pickerHosts;
          for (const source of captured.removedSources) {
            await client.request("removeUploadSource", { sourceId: source.sourceId, workspaceKey: context.workspacePath, binding }); removed.add(source.sourceId);
          }
          updatePicker(captured, { hosts, available: prepareConnection ? captured.available.map((host) => hosts.find((connected) => connected.hostId === host.hostId) ?? host) : captured.available,
            sources: captured.pickerSources, open: false, removedSources: [],
            savedSources: captured.savedSources.filter((source) => !removed.has(source.sourceId)) });
        } catch (failure) {
          updatePicker(captured, { sources: captured.sources.filter((source) => !removed.has(source.sourceId)),
            removedSources: captured.removedSources.filter((source) => !removed.has(source.sourceId)), savedSources: captured.savedSources.filter((source) => !removed.has(source.sourceId)),
            error: failure instanceof Error ? failure.message : t("requestFailed") });
        } finally { setDraft((previous) => previous.key === captured.key && previous.draftId === captured.draftId && previous.pickerId === captured.pickerId ? { ...previous, pending: false, applying: false } : previous); }
      }}
      savedSources={current.savedSources.filter((source) => !current.removedSources.some((removed) => removed.sourceId === source.sourceId))} hasMoreSources={Boolean(current.sourceCursor)}
      onLoadMoreSources={async () => {
        if (!client || current.pending || !current.sourceCursor) return; const captured = current; updatePicker(captured, { pending: true, error: "" });
        try {
          const page = await client.request("listUploadSources", { workspaceKey: context.workspacePath, binding, cursor: captured.sourceCursor, limit: 50 });
          updatePicker(captured, { savedSources: [...captured.savedSources, ...page.items.filter((source) => !captured.savedSources.some((item) => item.sourceId === source.sourceId))], sourceCursor: page.nextCursor });
        } catch (failure) { updatePicker(captured, { error: failure instanceof Error ? failure.message : t("requestFailed") }); }
        finally { updatePicker(captured, { pending: false }); }
      }} onConfirmSource={async (source) => {
        if (!client || current.pending) return; const captured = current; updatePicker(captured, { pending: true, error: "" });
        try {
          const confirmed = await sourceConfirmation.run("confirmUploadSource", { sourceId: source.sourceId, workspaceKey: context.workspacePath, binding,
            expectedManifestHash: source.manifestHash, expectedFrozenAt: source.frozenAt });
          updatePicker(captured, { pickerSources: [...captured.pickerSources.filter((item) => item.sourceId !== source.sourceId), confirmed] });
        } catch (failure) { updatePicker(captured, { error: failure instanceof Error ? failure.message : t("requestFailed") }); }
        finally { updatePicker(captured, { pending: false }); }
      }}
      canCancelPreparation={upload.canCancel || sourceConfirmation.active || connection.busy}
      cancelPreparationPending={upload.cancelRequested || sourceConfirmation.cancelRequested}
      onCancelPreparation={async () => {
        if (connection.busy) await connection.cancel().catch((failure) => updatePicker(current, {
          error: failure instanceof Error ? failure.message : t("requestFailed"),
        }));
        if (upload.canCancel) await upload.cancel();
        if (sourceConfirmation.active) await sourceConfirmation.cancel().catch((failure) => updatePicker(current, {
          error: failure instanceof Error ? failure.message : t("requestFailed"),
        }));
      }}
      pending={current.pending || upload.pending} connecting={connection.busy} prepareConnection={prepareConnection} error={current.error} pluginEnabled={current.pluginEnabled} onChange={(hosts) => updatePicker(current, { pickerHosts: hosts })}
      onChoose={upload.choose} onRemove={async (source) => {
        if (current.pending || upload.pending) return;
        updatePicker(current, { pickerSources: current.pickerSources.filter((item) => item.sourceId !== source.sourceId),
          removedSources: [...current.removedSources.filter((item) => item.sourceId !== source.sourceId), source] });
      }} />{upload.dialog}{connection.dialog}</>,
  };
}
