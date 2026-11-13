import { useRef, useState, type DragEvent } from "react";
import type { RemoteSelection, RemoteUploadSource } from "@fcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog.js";
import { useRemoteManagementOperation } from "./useRemoteManagementOperation.js";

interface UploadFailure { path: string; message: string; canRetry: boolean }
interface UploadIntent { key: string; pending: boolean; failures: UploadFailure[]; files: File[] }
const empty = (key: string): UploadIntent => ({ key, pending: false, failures: [], files: [] });

/** File objects stay private to this UI until the user chooses a purpose. No content reader runs here. */
export function useRemoteUploadIntents(context: {
  key: string; operationKey: string; enabled: boolean; managementPending: boolean; workspaceKey: string; binding: RemoteSelection["binding"];
  onSources(sources: RemoteUploadSource[]): void; onModelFiles(files: File[]): void; clearDragFeedback(): void;
}) {
  const platform = usePlatform(); const client = platform.remoteHosts; const { intl } = useFCodeIntl();
  const operation = useRemoteManagementOperation(client, context.operationKey);
  const t = (key: string) => intl.formatMessage({ id: `remoteHosts.${key}` });
  const [state, setState] = useState(() => empty(context.key));
  const current = state.key === context.key ? state : empty(context.key);
  if (state.key !== context.key) setState(current);
  const currentRef = useRef(current); currentRef.current = current;
  const update = (captured: UploadIntent, patch: Partial<UploadIntent>) => setState((previous) => previous.key === captured.key ? { ...previous, ...patch } : previous);
  const live = (captured: UploadIntent) => currentRef.current.key === captured.key;
  const canAdd = context.enabled && Boolean(client) && !context.managementPending && !current.pending;

  const addPaths = async (paths: string[], missing: UploadFailure[] = [], beforeFreeze?: () => void) => {
    if (!canAdd || !client) return;
    const captured = current; const unique = [...new Set(paths)];
    beforeFreeze?.(); update(captured, { pending: true, files: [] });
    try {
      if (unique.length > 8) {
        update(captured, { failures: [...captured.failures, ...unique.map((path) => ({ path, message: t("uploadBatchLimit"), canRetry: false })), ...missing] }); return;
      }
      const result = unique.length ? await operation.run("addUploadAttachments", { purpose: "remote_upload", paths: unique,
        workspaceKey: context.workspaceKey, binding: context.binding }) : { sources: [], failures: [] };
      if (!live(captured)) return;
      context.onSources(result.sources);
      update(captured, { failures: [...captured.failures.filter((failure) => !unique.includes(failure.path)), ...missing,
        ...result.failures.map(({ path, error }) => ({ path, message: error.message, canRetry: true }))] });
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : t("requestFailed");
      update(captured, { failures: [...captured.failures.filter((item) => !unique.includes(item.path)), ...missing,
        ...unique.map((path) => ({ path, message, canRetry: true }))] });
    } finally { update(captured, { pending: false }); }
  };
  const addFiles = async (files: File[]) => {
    if (files.length > 8) {
      update(current, { files: [], failures: [...current.failures, { path: t("uploadSelection"), message: t("uploadBatchLimit"), canRetry: false }] }); return;
    }
    const paths: string[] = []; const missing: UploadFailure[] = [];
    for (const file of files) {
      let path: string | null | undefined;
      try { path = platform.getPathForFile?.(file); } catch { /* Missing native paths fail closed. */ }
      if (path) paths.push(path); else missing.push({ path: file.name, message: t("uploadLocalPathRequired"), canRetry: false });
    }
    await addPaths(paths, missing);
  };
  const choose = async (kind: "file" | "directory") => {
    if (!canAdd || !client) return; const captured = current; update(captured, { pending: true });
    try {
      const source = await operation.run("chooseUploadSource", { workspaceKey: context.workspaceKey, binding: context.binding, kind });
      if (source && live(captured)) context.onSources([source]);
    } catch (failure) { update(captured, { failures: [...captured.failures, { path: t("uploadSelection"),
      message: failure instanceof Error ? failure.message : t("requestFailed"), canRetry: false }] }); }
    finally { update(captured, { pending: false }); }
  };
  const offerDrop = (files: File[]) => {
    context.clearDragFeedback();
    if (canAdd) update(current, { files: [...files] });
  };
  return {
    canAdd, pending: current.pending, blocked: current.pending || current.files.length > 0 || current.failures.length > 0,
    canCancel: operation.active, cancelRequested: operation.cancelRequested,
    cancel: () => operation.cancel().catch((failure) => update(current, { failures: [...current.failures, { path: t("uploadSelection"),
      message: failure instanceof Error ? failure.message : t("requestFailed"), canRetry: false }] })),
    choose, addPaths, offerDrop,
    dropHandlers: {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (context.enabled && Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; }
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        const files = Array.from(event.dataTransfer.files); if (!context.enabled || !files.length) return;
        event.preventDefault(); event.stopPropagation(); context.clearDragFeedback(); void addFiles(files);
      },
    },
    status: context.enabled && (current.pending || current.failures.length > 0) ? <div className="w-full space-y-1 break-all rounded border p-2" data-testid="remote-upload-intent-status">
      {current.pending && <p role="status">{t("freezingSources")}</p>}
      {operation.active && <Button type="button" variant="outline" size="sm" disabled={operation.cancelRequested}
        onClick={() => void operation.cancel().catch((failure) => update(current, { failures: [...current.failures, { path: t("uploadSelection"),
          message: failure instanceof Error ? failure.message : t("requestFailed"), canRetry: false }] }))}>{t(operation.cancelRequested ? "cancelPreparationPending" : "cancelPreparation")}</Button>}
      {current.failures.map((failure, index) => <p key={`${failure.path}:${index}`} role="alert">{failure.path}: {failure.message}</p>)}
      {!!current.failures.length && <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={!canAdd || !current.failures.some((failure) => failure.canRetry)}
          onClick={() => void addPaths(current.failures.filter((failure) => failure.canRetry).map((failure) => failure.path))}>{t("retryFreeze")}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={current.pending} onClick={() => update(current, { failures: [] })}>{t("removeFailedSources")}</Button>
      </div>}
    </div> : null,
    dialog: <Dialog open={context.enabled && current.files.length > 0} onOpenChange={(open) => { if (!open) update(current, { files: [] }); }}>
      <DialogContent><DialogHeader><DialogTitle>{t("attachmentPurpose")}</DialogTitle></DialogHeader>
        <p>{t("attachmentPurposeHelp")}</p><ul className="max-h-40 overflow-auto break-all">{current.files.map((file, index) => <li key={`${file.name}:${index}`}>{file.name}</li>)}</ul>
        <DialogFooter className="flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => { const files = current.files; update(current, { files: [] }); if (live(current)) context.onModelFiles(files); }}>{t("useAsModelContext")}</Button>
          <Button type="button" disabled={!canAdd} onClick={() => void addFiles(current.files)}>{t("uploadOnly")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>,
  };
}
