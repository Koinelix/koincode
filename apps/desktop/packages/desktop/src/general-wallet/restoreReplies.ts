const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function check(value: unknown): asserts value { if (!value) throw new Error("GENERAL_SETUP_REPLY_INVALID"); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value));
  check(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))); return value as Record<string, unknown>;
}
const id = (value: unknown): boolean => typeof value === "string" && UUID.test(value);
export function assertGeneralRestorePasswordRequest(value: unknown): void {
  const row = record(value, ["requestId", "challengeId", "stage"]);
  check(id(row.requestId) && id(row.challengeId) && (row.stage === "prepare" || row.stage === "publish"));
}

/** Strict display-only projections; no plan, path, protected reference or native capability. */
export function assertGeneralRestoreReply(action: unknown, value: unknown): void {
  if (action === "restore_password" || action === "restore_cancel") { check(value === null); return; }
  if (action === "restore_options") {
    const row = record(value, ["available", "requestId"]); check(typeof row.available === "boolean" && (row.available ? id(row.requestId) : row.requestId === null)); return;
  }
  if (action === "restore_publish") {
    const row = record(value, ["recoveryId", "signingMode", "phase"]);
    check(id(row.recoveryId) && (row.signingMode === "live" || row.signingMode === "archive_only") && row.phase === "reopened"); return;
  }
  check(action === "restore_prepare");
  const row = record(value, ["requestId", "backupId", "mode", "phase", "signingContinuity", "selectedKeyCount", "accounts"]);
  check(id(row.requestId) && id(row.backupId) && (row.mode === "same_installation" || row.mode === "new_installation") &&
    ["prepared", "keys_staged", "projection_staged", "binding_published", "reopened"].includes(row.phase as string) &&
    (row.signingContinuity === "complete" || row.signingContinuity === "unknown") && (row.mode !== "new_installation" || row.signingContinuity === "unknown") &&
    Number.isInteger(row.selectedKeyCount) && (row.selectedKeyCount as number) >= 1 && (row.selectedKeyCount as number) <= 1256 &&
    Array.isArray(row.accounts) && row.accounts.length <= 256);
  const addresses = new Set(); let selected = 0;
  for (const item of row.accounts) {
    const source = record(item, ["address", "sourceType", "status", "materialSelected"]);
    check(typeof source.address === "string" && /^0x[0-9a-f]{40}$/.test(source.address) && !addresses.has(source.address) &&
      ["mnemonic", "private_key"].includes(source.sourceType as string) && ["staged", "ready"].includes(source.status as string) && typeof source.materialSelected === "boolean");
    addresses.add(source.address); if (source.materialSelected) selected++;
  }
  check(selected <= (row.selectedKeyCount as number));
}
