const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const matches = (value: unknown, pattern: RegExp): boolean => typeof value === "string" && pattern.test(value);
function check(value: unknown): asserts value { if (!value) throw new Error("GENERAL_SETUP_REPLY_INVALID"); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value));
  check(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
  return value as Record<string, unknown>;
}

/** Only public coverage labels/counts cross the original protected UI boundary. */
export function assertGeneralBackupReply(action: unknown, value: unknown): void {
  if (action === "backup_select" || action === "backup_cancel") { check(value === null); return; }
  if (action === "backup_export") {
    const row = record(value, ["backupId", "sourceKeyCount", "pendingKeyCount", "allReferencedKeys"]);
    check(matches(row.backupId, UUID) && typeof row.allReferencedKeys === "boolean" &&
      Number.isInteger(row.sourceKeyCount) && (row.sourceKeyCount as number) >= 0 && (row.sourceKeyCount as number) <= 256 &&
      Number.isInteger(row.pendingKeyCount) && (row.pendingKeyCount as number) >= 0 && (row.pendingKeyCount as number) <= 1000 &&
      (row.sourceKeyCount as number) + (row.pendingKeyCount as number) > 0); return;
  }
  check(action === "backup_options");
  const row = record(value, ["available", "requestId", "sources", "pendingSetups"]);
  check(typeof row.available === "boolean" && Array.isArray(row.sources) && row.sources.length <= 256 && Array.isArray(row.pendingSetups) && row.pendingSetups.length <= 1000);
  if (!row.available) { check(row.requestId === null && row.sources.length === 0 && row.pendingSetups.length === 0); return; }
  check(matches(row.requestId, UUID));
  const sources = new Set(), addresses = new Set(), setups = new Set();
  for (const value of row.sources) {
    const item = record(value, ["sourceId", "address", "sourceType", "status", "backupVerified"]);
    check(matches(item.sourceId, UUID) && !sources.has(item.sourceId) && matches(item.address, ADDRESS) && !addresses.has(item.address) &&
      ["mnemonic", "private_key"].includes(item.sourceType as string) && ["staged", "ready"].includes(item.status as string) && typeof item.backupVerified === "boolean");
    sources.add(item.sourceId); addresses.add(item.address);
  }
  for (const value of row.pendingSetups) {
    const item = record(value, ["setupId", "mode", "phase", "createdAt"]);
    check(matches(item.setupId, UUID) && !setups.has(item.setupId) && ["create", "import_mnemonic", "import_private_key"].includes(item.mode as string) &&
      ["started", "secret_staged", "backup_pending", "canceled"].includes(item.phase as string) && Number.isSafeInteger(item.createdAt) && (item.createdAt as number) >= 0);
    setups.add(item.setupId);
  }
}
