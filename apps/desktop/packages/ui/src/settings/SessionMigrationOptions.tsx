import type { useSessionMigration } from "@/hooks/useSessionMigration.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { SessionMigrationSourceSelector } from "./SessionMigrationSourceSelector.js";
import { sessionMigrationReason } from "./sessionMigrationReason.js";

export function SessionMigrationOptions({
  migration,
}: {
  migration: ReturnType<typeof useSessionMigration>;
}) {
  const platform = usePlatform();
  const { intl } = useFCodeIntl();
  return (
    <div className="shrink-0 space-y-3">
      <SessionMigrationSourceSelector
        source={migration.source}
        onChange={migration.setSource}
        disabled={migration.isImporting}
      />
      <p className="text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "settings.migration.textOnlyNotice" })}
      </p>
      {migration.source === "antigravity" ? (
        <p className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "settings.migration.reason.antigravity_open_required" })}
        </p>
      ) : null}
      {migration.diagnostics.length ? (
        <div
          role="status"
          className="max-h-24 overflow-y-auto rounded-lg border border-border p-3 text-ui-sm"
        >
          {migration.diagnostics.map((item, index) => (
            <div key={index}>
              {item.sessionId ? `${item.sessionId}: ` : ""}
              {sessionMigrationReason(intl, item.reason)}
            </div>
          ))}
        </div>
      ) : null}
      {migration.candidates.some((candidate) => !candidate.workspacePath) ? (
        <div className="max-h-32 space-y-2 overflow-y-auto rounded-lg border border-border p-3">
          <p className="text-ui-sm">
            {intl.formatMessage({ id: "settings.migration.targetRequired" })}
          </p>
          {migration.candidates
            .filter((candidate) => !candidate.workspacePath)
            .map((candidate) => (
              <div
                key={candidate.sessionId}
                className="flex items-center justify-between gap-2 text-ui-sm"
              >
                <span className="truncate">{candidate.previewTitle || candidate.sessionId}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={migration.isImporting}
                  onClick={() => {
                    void platform.selectDirectory().then((path) => {
                      if (path) migration.setTargetWorkspacePath(candidate.sessionId, path);
                    });
                  }}
                >
                  {intl.formatMessage({ id: "settings.migration.selectTarget" })}
                </Button>
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
}
