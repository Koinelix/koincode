import type { RemoteUploadSource, RemoteUploadSourcePreview } from "@fcode/shared";
import { Button } from "@/components/ui/button.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";

export function RemoteUploadSourcesPanel(props: {
  sources: RemoteUploadSource[]; savedSources: RemoteUploadSourcePreview[]; pending: boolean; hasMore: boolean;
  onConfirm(source: RemoteUploadSourcePreview): Promise<void>; onRemove(source: RemoteUploadSource): Promise<void>;
  onLoadMore(): Promise<void>;
}) {
  const { intl, locale } = useFCodeIntl(); const t = (key: string) => intl.formatMessage({ id: `remoteHosts.${key}` });
  const saved = props.savedSources.filter((source) => !props.sources.some((selected) => selected.sourceId === source.sourceId));
  const summary = (source: RemoteUploadSource) => <>
    <p>{source.displayName} · {source.fileCount} files · {source.totalBytes} B · {source.skippedCount} skipped</p>
    <p>{t("frozenAt")}: {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(source.frozenAt)}</p>
    <p className="font-mono text-ui-xs">SHA-256 {source.manifestHash}</p>
  </>;
  return <div className="space-y-2" data-testid="remote-upload-sources">
    {props.sources.map((source) => <div key={source.sourceId} className="space-y-1 break-all rounded border p-2" data-purpose="remote_upload">
      {summary(source)}<Button type="button" variant="ghost" disabled={props.pending} onClick={() => void props.onRemove(source)}>{t("removeSource")}</Button>
    </div>)}
    {!!saved.length && <p className="text-ui-sm text-muted-foreground">{t("restoreSourceHelp")}</p>}
    {saved.map((source) => <div key={source.sourceId} className="space-y-1 break-all rounded border p-2" data-purpose="remote_upload" data-testid={`remote-upload-source-${source.sourceId}`}>
      {summary(source)}<p className="font-mono text-ui-xs">{source.originalPath}</p>
      <p>{t(`sourceAvailability.${source.availability}`)}</p>
      <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={props.pending || source.availability === "expired"}
        onClick={() => void props.onConfirm(source)}>{t("confirmFrozenSource")}</Button>
        <Button type="button" variant="ghost" disabled={props.pending} onClick={() => void props.onRemove(source)}>{t("removeSource")}</Button></div>
    </div>)}
    {props.hasMore && <Button type="button" variant="outline" disabled={props.pending} onClick={() => void props.onLoadMore()}>{t("loadMore")}</Button>}
  </div>;
}
