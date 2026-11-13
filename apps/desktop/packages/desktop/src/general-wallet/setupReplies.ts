import { assertGeneralRestoreReply } from "./restoreReplies.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const PHRASE = /^[a-z]+(?: [a-z]+){11}$/;
const MODES = new Set(["create", "import_mnemonic", "import_private_key"]);
const PHASES = new Set(["started", "secret_staged", "backup_pending", "canceled"]);
import { GENERAL_NETWORKS } from "@koincode/wallet/general";
import { assertGeneralBackupReply } from "./backupReplies.js";
function record(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)))
    throw new Error("GENERAL_SETUP_REPLY_INVALID");
  return value as Record<string, unknown>;
}
const matches = (value: unknown, pattern: RegExp): boolean => typeof value === "string" && pattern.test(value);
const validPhrase = (value: unknown): boolean => typeof value === "string" && value.length <= 1024 && PHRASE.test(value);
function requireReply(ok: boolean): void { if (!ok) throw new Error("GENERAL_SETUP_REPLY_INVALID"); }

/** Fail closed before the private renderer boundary; never return an internal state object by accident. */
export function assertGeneralSetupReply(action: unknown, value: unknown, expectedExportFormat?: unknown): void {
  switch (action) {
    case "restore_options": case "restore_prepare": case "restore_publish": case "restore_password": case "restore_cancel": assertGeneralRestoreReply(action, value); return;
    case "backup_options": case "backup_select": case "backup_export": case "backup_cancel": assertGeneralBackupReply(action, value); return;
    case "manual_options": {
      const row = record(value, ["available", "requestId", "networks"]);
      requireReply(typeof row.available === "boolean" && Array.isArray(row.networks));
      if (!row.available) { requireReply(row.requestId === null && (row.networks as unknown[]).length === 0); return; }
      requireReply(matches(row.requestId, UUID) && (row.networks as unknown[]).length === GENERAL_NETWORKS.length);
      const seen = new Set();
      for (const item of row.networks as unknown[]) {
        const entry = record(item, ["networkId", "testnet", "reason", "assets"]), network = GENERAL_NETWORKS.find((candidate) => candidate.id === entry.networkId);
        requireReply(Boolean(network) && !seen.has(entry.networkId) && entry.testnet === network!.testnet); seen.add(entry.networkId);
        const reason = entry.networkId === "eip155:84532" ? "legacy_network_reserved" : ["eip155:8453", "eip155:10", "eip155:11155420"].includes(entry.networkId as string) ? "fee_cap_unavailable" : null;
        requireReply(entry.reason === reason && Array.isArray(entry.assets) && entry.assets.length >= 1 && entry.assets.length <= 21);
        const assets = new Set();
        for (const [index, asset] of (entry.assets as unknown[]).entries()) {
          const token = record(asset, ["assetId", "symbol", "decimals"]);
          requireReply(!assets.has(token.assetId) && typeof token.symbol === "string" && token.symbol.length > 0 && token.symbol.length <= 32 &&
            Number.isInteger(token.decimals) && (token.decimals as number) >= 0 && (token.decimals as number) <= 255 &&
            (index === 0 ? token.assetId === "native" && token.decimals === 18 && token.symbol === network!.nativeSymbol : matches(token.assetId, /^erc20:0x[0-9a-f]{40}$/)));
          assets.add(token.assetId);
        }
      }
      return;
    }
    case "manual_send": {
      const row = record(value, ["status", "transactionHash"]);
      requireReply((row.status === "SUBMITTED" || row.status === "UNKNOWN") && matches(row.transactionHash, /^0x[0-9a-f]{64}$/)); return;
    }
    case "connect_payment": {
      const row = record(value, ["status"], ["walletId"]);
      requireReply(row.status === "needs_upgrade" && row.walletId === undefined || row.status === "connected" && matches(row.walletId, UUID)); return;
    }
    case "upgrade_payments": {
      const row = record(value, ["upgraded", "backupPath"]);
      requireReply(typeof row.upgraded === "boolean" && (row.backupPath === null || typeof row.backupPath === "string" && row.backupPath.length <= 4096)); return;
    }
    case "status": {
      const row = record(value, ["accounts", "setups"]);
      requireReply(Array.isArray(row.accounts) && row.accounts.length <= 256 && Array.isArray(row.setups) && row.setups.length <= 1000);
      for (const item of row.accounts as unknown[]) {
        const account = record(item, ["sourceId", "address", "sourceType", "backupVerified"], ["name"]);
        requireReply(matches(account.sourceId, UUID) && matches(account.address, ADDRESS) &&
          (account.sourceType === "mnemonic" || account.sourceType === "private_key") && typeof account.backupVerified === "boolean" && (account.name === undefined || typeof account.name === "string" && [...account.name].length <= 40));
      }
      for (const item of row.setups as unknown[]) {
        const setup = record(item, ["setupId", "mode", "phase", "createdAt"]);
        requireReply(matches(setup.setupId, UUID) && typeof setup.mode === "string" && MODES.has(setup.mode) &&
          typeof setup.phase === "string" && PHASES.has(setup.phase) && Number.isSafeInteger(setup.createdAt) && (setup.createdAt as number) >= 0);
      }
      return;
    }
    case "begin": requireReply(matches(record(value, ["setupId"]).setupId, UUID)); return;
    case "stage_create": case "stage_mnemonic": case "stage_private_key": {
      const row = record(value, ["status", "address"]);
      requireReply(matches(row.address, ADDRESS) && ["staged", "already_exists", "recovery_required", "legacy_account"].includes(row.status as string)); return;
    }
    case "preview_accounts": {
      const row = record(value, ["previewId", "accounts", "nextOffset"]);
      requireReply(matches(row.previewId, UUID) && Array.isArray(row.accounts) && row.accounts.length >= 1 && row.accounts.length <= 10 &&
        (row.nextOffset === null || Number.isInteger(row.nextOffset) && (row.nextOffset as number) >= 0 && (row.nextOffset as number) <= 2147483647));
      for (const item of row.accounts as unknown[]) {
        const account = record(item, ["accountIndex", "address", "derivationPath", "alreadyImported"]);
        requireReply(Number.isInteger(account.accountIndex) && (account.accountIndex as number) >= 0 && (account.accountIndex as number) <= 2147483647 &&
          matches(account.address, ADDRESS) && account.derivationPath === `m/44'/60'/0'/0/${account.accountIndex}` && typeof account.alreadyImported === "boolean");
      }
      return;
    }
    case "import_accounts": {
      const row = record(value, ["results"]);
      requireReply(Array.isArray(row.results) && row.results.length >= 1 && row.results.length <= 20);
      for (const item of row.results as unknown[]) {
        const result = record(item, ["accountIndex", "address", "status"], ["paymentStatus"]);
        requireReply(Number.isInteger(result.accountIndex) && (result.accountIndex as number) >= 0 && (result.accountIndex as number) <= 2147483647 &&
          matches(result.address, ADDRESS) && ["imported", "already_exists", "recovery_required", "legacy_account", "failed"].includes(result.status as string) &&
          (result.paymentStatus === undefined || result.status === "imported" && ["connected", "needs_upgrade", "unavailable"].includes(result.paymentStatus as string)));
      }
      return;
    }
    case "preview_mnemonic": case "preview_private_key": {
      const mnemonic = action === "preview_mnemonic";
      const row = record(value, ["address", "sourceType", ...(mnemonic ? ["derivationPath"] : [])]);
      requireReply(matches(row.address, ADDRESS) && row.sourceType === (mnemonic ? "mnemonic" : "private_key") &&
        (!mnemonic || typeof row.derivationPath === "string" && /^m\/44'\/60'\/0'\/0\/(0|[1-9][0-9]{0,9})$/.test(row.derivationPath) && Number(row.derivationPath.split("/").at(-1)) <= 2147483647)); return;
    }
    case "reveal_created": {
      const row = record(value, ["phrase", "positions"]);
      requireReply(validPhrase(row.phrase) && Array.isArray(row.positions) && row.positions.length === 3 &&
        new Set(row.positions).size === 3 && row.positions.every((item) => Number.isInteger(item) && item >= 0 && item < 12)); return;
    }
    case "reveal_ready_mnemonic": requireReply(validPhrase(record(value, ["phrase"]).phrase)); return;
    case "export_secret": {
      const format = record(value, ["format"], ["phrase", "privateKey"]).format;
      requireReply((expectedExportFormat === "mnemonic" || expectedExportFormat === "private_key") && format === expectedExportFormat);
      if (format === "mnemonic") requireReply(validPhrase(record(value, ["format", "phrase"]).phrase));
      else { requireReply(format === "private_key"); requireReply(matches(record(value, ["format", "privateKey"]).privateKey, /^0x[0-9a-f]{64}$/)); }
      return;
    }
    case "confirm_backup": requireReply(typeof record(value, ["verified"]).verified === "boolean"); return;
    case "rename_account": case "confirm_import": case "cancel": case "resume": case "manual_cancel": case "cancel_secret_export": requireReply(value === null); return;
    case "history": assertGeneralHistoryReply(value); return;
    default: throw new Error("GENERAL_SETUP_REPLY_INVALID");
  }
}
import { assertGeneralHistoryReply } from "./historyReplies.js";

