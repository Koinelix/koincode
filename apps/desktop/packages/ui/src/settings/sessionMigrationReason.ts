import type { IntlInstance } from "@/i18n/IntlProvider.js";

export function sessionMigrationReason(intl: IntlInstance, reason: string): string {
  const id = `settings.migration.reason.${reason}`;
  const translated = intl.formatMessage({ id });
  return translated === id ? reason : translated;
}
