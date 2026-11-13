import { useId } from "react";
import type { FCodeImportSessionSourceProvider } from "@fcode/shared";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";

export const SESSION_MIGRATION_LABELS = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
};
export function SessionMigrationSourceSelector(props: {
  source: FCodeImportSessionSourceProvider;
  disabled?: boolean;
  onChange: (source: FCodeImportSessionSourceProvider) => void;
}) {
  const name = useId();
  const { intl } = useFCodeIntl();
  return (
    <fieldset
      disabled={props.disabled}
      className="min-w-0 space-y-2"
      data-testid="migration-source-selector"
    >
      <legend className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.migration.sourceLabel" })}
      </legend>
      <div className="flex flex-wrap gap-x-5 gap-y-3">
        {(Object.keys(SESSION_MIGRATION_LABELS) as FCodeImportSessionSourceProvider[]).map(
          (source) => (
            <label key={source} className="flex cursor-pointer items-center gap-2 text-ui-base">
              <input
                type="radio"
                name={name}
                value={source}
                checked={props.source === source}
                onChange={() => props.onChange(source)}
                className="size-4 shrink-0 appearance-none rounded-full border border-foreground-subtle bg-transparent checked:border-[5px] checked:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
              {SESSION_MIGRATION_LABELS[source]}
            </label>
          ),
        )}
      </div>
    </fieldset>
  );
}
