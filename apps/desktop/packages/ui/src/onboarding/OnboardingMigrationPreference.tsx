import type { FCodeImportSessionSourceProvider } from "@fcode/shared";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import { SessionMigrationSourceSelector } from "@/settings/SessionMigrationSourceSelector.js";

export function OnboardingMigrationPreference(props: {
  enabled: boolean;
  source: FCodeImportSessionSourceProvider;
  disabled: boolean;
  onEnabled: (value: boolean) => void;
  onSource: (value: FCodeImportSessionSourceProvider) => void;
}) {
  const { intl } = useFCodeIntl();
  return (
    <div className="space-y-4 rounded-xl border border-card-border bg-card p-5 dark:bg-surface/40">
      <label className="grid cursor-pointer grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-ui-base">
        <Checkbox
          checked={props.enabled}
          disabled={props.disabled}
          onCheckedChange={(value) => props.onEnabled(value === true)}
        />
        <span className="font-medium">
          {intl.formatMessage({ id: "occupationOnboarding.migration" })}
        </span>
        <span className="col-start-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "occupationOnboarding.migrationDescription" })}
        </span>
      </label>
      <SessionMigrationSourceSelector
        source={props.source}
        onChange={(source) => {
          props.onSource(source);
          props.onEnabled(true);
        }}
        disabled={props.disabled}
      />
    </div>
  );
}
