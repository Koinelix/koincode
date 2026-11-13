import { z } from "zod";
import { randomUUID } from "node:crypto";
import { requireWallet } from "../domain/errors.js";
import type { GeneralSetupCoordinator } from "./generalSetupCoordinator.js";
import type { GeneralHistoryQuery, GeneralHistoryPage } from "./generalTransferHistory.js";
import { GENERAL_NETWORKS } from "../domain/generalNetworks.js";
import { generalTokens } from "../domain/generalTokens.js";
import { parseGeneralTransferInput, type GeneralTransferInput } from "./generalTransferDraftReader.js";
import { GeneralBackupManagement, type GeneralBackupInputPort } from "./generalBackupManagement.js";

import { GeneralRestoreManagement, type GeneralRestoreInput } from "./generalRestoreManagement.js";

const manualAsset = z.strictObject({ assetId: z.string().regex(/^erc20:0x[0-9a-f]{40}$/), symbol: z.string().min(1).max(32), decimals: z.number().int().min(0).max(255) });
const manualResult = z.strictObject({ status: z.enum(["SUBMITTED", "UNKNOWN"]), transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/) });
export type GeneralManualInputPort = {
  send(input: GeneralTransferInput, signal: AbortSignal): Promise<z.infer<typeof manualResult>>;
  /** Complete trusted ERC-20 registry for this fixed host configuration; never supplied by the page. */
  assets?(networkId: string): Array<z.infer<typeof manualAsset>>;
};

const MAX_COMMAND_BYTES = 8192;
const id = z.string().uuid();
const mode = z.enum(["create", "import_mnemonic", "import_private_key"]);
const mnemonic = z.string().min(1).max(1024);
const privateKey = z.string().min(1).max(256);
const accountIndex = z.number().int().min(0).max(2147483647);
const address = z.string().regex(/^0x[0-9a-f]{40}$/i);
const schema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("status") }),
  z.strictObject({ action: z.literal("manual_options") }),
  z.strictObject({ action: z.literal("manual_send"), requestId: id, input: z.unknown() }),
  z.strictObject({ action: z.literal("manual_cancel"), requestId: id }),
  z.strictObject({ action: z.literal("restore_options") }),
  z.strictObject({ action: z.literal("restore_prepare"), requestId: id }),
  z.strictObject({ action: z.literal("restore_publish"), requestId: id }),
  z.strictObject({ action: z.literal("restore_password"), requestId: id, challengeId: id, password: z.string().min(1).max(8192) }),
  z.strictObject({ action: z.literal("restore_cancel"), requestId: id }),
  z.strictObject({ action: z.literal("backup_options") }),
  z.strictObject({ action: z.literal("backup_select"), requestId: id, kind: z.enum(["source", "pending"]), itemId: id, selected: z.boolean() }),
  z.strictObject({ action: z.literal("backup_export"), requestId: id, password: z.string().min(1).max(8192) }),
  z.strictObject({ action: z.literal("backup_cancel"), requestId: id }),
  z.strictObject({ action: z.literal("begin"), mode }),
  z.strictObject({ action: z.literal("stage_create"), setupId: id }),
  z.strictObject({ action: z.literal("preview_mnemonic"), setupId: id, phrase: mnemonic, accountIndex: accountIndex.optional() }),
  z.strictObject({ action: z.literal("preview_accounts"), setupId: id, phrase: mnemonic, offset: accountIndex, previewId: id.optional() }),
  z.strictObject({ action: z.literal("import_accounts"), setupId: id, phrase: mnemonic, previewId: id, accounts: z.array(z.strictObject({ accountIndex, address })).min(1).max(20) }),
  z.strictObject({ action: z.literal("preview_private_key"), setupId: id, privateKey }),
  z.strictObject({ action: z.literal("stage_mnemonic"), setupId: id, phrase: mnemonic, confirmedAddress: address, accountIndex: accountIndex.optional() }),
  z.strictObject({ action: z.literal("stage_private_key"), setupId: id, privateKey, confirmedAddress: address }),
  z.strictObject({ action: z.literal("reveal_created"), setupId: id }),
  z.strictObject({ action: z.literal("confirm_backup"), setupId: id, words: z.array(z.string().min(1).max(64)).length(3) }),
  z.strictObject({ action: z.literal("confirm_import"), setupId: id }),
  z.strictObject({ action: z.literal("cancel"), setupId: id }),
  z.strictObject({ action: z.literal("resume"), setupId: id }),
  z.strictObject({ action: z.literal("reveal_ready_mnemonic"), sourceId: id }),
  z.strictObject({ action: z.literal("export_secret"), sourceId: id, format: z.enum(["mnemonic", "private_key"]) }),
  z.strictObject({ action: z.literal("cancel_secret_export") }),
  z.strictObject({ action: z.literal("history"), sourceId: id, networkId: z.string().max(32),
    offset: z.number().int().min(0).max(1000), limit: z.number().int().min(1).max(20), head: z.string().regex(/^[0-9a-f]{64}$/).optional() }),
]);
export type GeneralSetupCommand = z.infer<typeof schema>;

function command(value: unknown): GeneralSetupCommand {
  let size = MAX_COMMAND_BYTES + 1;
  try { size = Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { /* Reject non-JSON commands. */ }
  requireWallet(size <= MAX_COMMAND_BYTES, "INVALID_REQUEST", "The setup command is invalid.");
  const parsed = schema.safeParse(value);
  requireWallet(parsed.success, "INVALID_REQUEST", "The setup command is invalid.");
  return parsed.data;
}

/** Private to the protected host; never attach this dispatcher to the asset or model IPC. */
export class GeneralSetupSession {
  private busy = false;
  private canceling = false;
  private closed = false;
  private draining?: Promise<void>;
  private activeDone?: Promise<void>;
  private manualRequest?: string;
  private manualOperation?: { requestId: string; controller: AbortController };
  private backupOperation?: { requestId: string; controller: AbortController };
  private readonly backup: GeneralBackupManagement;
  private readonly restore: GeneralRestoreManagement;
  private restoreOperation = false;
  constructor(private readonly setup: GeneralSetupCoordinator,
    private readonly lifetime: { isCurrent(): boolean; closeOwner(): Promise<void> },
    private readonly history?: { read(input: GeneralHistoryQuery): Promise<GeneralHistoryPage> }, private readonly manual?: GeneralManualInputPort,
    backup?: GeneralBackupInputPort, restore?: GeneralRestoreInput) {
    this.backup = new GeneralBackupManagement(backup);
    this.restore = new GeneralRestoreManagement(restore, () => !this.closed && this.lifetime.isCurrent() === true);
  }

  private current(): void {
    let current = false;
    try { current = !this.closed && this.lifetime.isCurrent() === true; } catch { /* A missing lifetime is invalid. */ }
    if (!current) {
      void this.close().catch(() => {});
      requireWallet(false, "GENERAL_OPERATION_CANCELED", "The sensitive host lifetime has ended.");
    }
  }

  async dispatch(value: unknown): Promise<unknown> {
    this.current();
    const input = command(value);
    const cancellation = input.action === "cancel" || input.action === "cancel_secret_export" || input.action === "manual_cancel" || input.action === "backup_cancel" || input.action === "restore_cancel" || input.action === "restore_password";
    const matching = input.action === "restore_cancel" || input.action === "restore_password" ? this.restore.matches(input.requestId) : input.action === "manual_cancel" ? Boolean(this.manualOperation) : input.action === "backup_cancel" ? Boolean(this.backupOperation) : !this.manualOperation && !this.backupOperation && !this.restoreOperation;
    requireWallet(!this.canceling && (!this.busy || cancellation && matching),
      "GENERAL_OPERATION_BUSY", "A protected management operation is already running.");
    let finish: (() => void) | undefined;
    if (cancellation) this.canceling = true;
    else { this.busy = true; this.activeDone = new Promise<void>((resolve) => { finish = resolve; }); }
    try {
      const result = await this.execute(input);
      this.current();
      return result;
    } finally { if (cancellation) this.canceling = false; else { this.busy = false; this.activeDone = undefined; finish?.(); } }
  }

  private async execute(input: GeneralSetupCommand): Promise<unknown> {
    switch (input.action) {
      case "status": return { accounts: this.setup.listAccounts(), setups: this.setup.listSetups() };
      case "restore_options": return this.restore.options();
      case "restore_prepare": case "restore_publish": {
        this.restoreOperation = true;
        try { return await (input.action === "restore_prepare" ? this.restore.prepare(input.requestId) : this.restore.publish(input.requestId)); }
        finally { this.restoreOperation = false; }
      }
      case "restore_password": return this.restore.password(input);
      case "restore_cancel": return this.restore.cancel(input.requestId);
      case "backup_options": return this.backup.options();
      case "backup_select": return this.backup.select(input.requestId, input.kind, input.itemId, input.selected);
      case "backup_export": {
        const operation = { requestId: input.requestId, controller: new AbortController() }; this.backupOperation = operation;
        try { return await this.backup.export(input, operation.controller.signal); }
        finally { input.password = ""; if (this.backupOperation === operation) this.backupOperation = undefined; }
      }
      case "backup_cancel": {
        requireWallet(this.backupOperation?.requestId === input.requestId, "GENERAL_OPERATION_CANCELED", "The original backup operation is unavailable.");
        this.backupOperation.controller.abort(); return null;
      }
      case "manual_options": {
        this.manualRequest = undefined;
        if (!this.manual) return { available: false, requestId: null, networks: [] };
        const networks = GENERAL_NETWORKS.map((network) => {
          const configured = this.manual!.assets?.(network.id) ?? generalTokens(network.id).map((token) => ({ assetId: `erc20:${token.address}`, symbol: token.symbol, decimals: token.decimals }));
          const tokens = z.array(manualAsset).max(20).parse(configured);
          requireWallet(new Set(tokens.map((asset) => asset.assetId)).size === tokens.length, "INVALID_ASSET", "The host asset registry is ambiguous.");
          return { networkId: network.id, testnet: network.testnet,
            reason: ["eip155:8453", "eip155:84532"].includes(network.id) ? "legacy_network_reserved" : ["eip155:8453", "eip155:10", "eip155:11155420"].includes(network.id) ? "fee_cap_unavailable" : null,
            assets: [{ assetId: "native", symbol: network.nativeSymbol, decimals: 18 }, ...tokens] };
        });
        this.manualRequest = randomUUID(); return { available: true, requestId: this.manualRequest, networks };
      }
      case "manual_send": {
        requireWallet(this.manual && input.requestId === this.manualRequest && !this.manualOperation,
          "GENERAL_OPERATION_CANCELED", "The original manual input request is unavailable.");
        const intent = parseGeneralTransferInput(input.input);
        requireWallet(this.setup.listAccounts().some((account) => account.sourceId === intent.accountId),
          "GENERAL_ACCOUNT_UNAVAILABLE", "A current ready account is required.");
        this.manualRequest = undefined;
        const operation = { requestId: input.requestId, controller: new AbortController() }; this.manualOperation = operation;
        try {
          const result = await this.manual.send(intent, operation.controller.signal); this.current();
          requireWallet(!operation.controller.signal.aborted, "TRANSACTION_STATE_UNKNOWN", "Check the original manual operation before another transfer.");
          return manualResult.parse(result);
        }
        finally { if (this.manualOperation === operation) this.manualOperation = undefined; }
      }
      case "manual_cancel": {
        requireWallet(this.manualOperation?.requestId === input.requestId, "GENERAL_OPERATION_CANCELED", "The original manual operation is unavailable.");
        this.manualOperation.controller.abort(); return null;
      }
      case "begin": return this.setup.begin(input.mode);
      case "stage_create": return this.setup.stage(input.setupId, { mode: "create" });
      case "preview_accounts": return this.setup.previewAccounts(input.setupId, input.phrase, input.offset, input.previewId);
      case "import_accounts": return this.setup.importAccounts(input.setupId, input.phrase, input.previewId, input.accounts);
      case "preview_mnemonic": return this.setup.previewImport(input.setupId, { mode: "import_mnemonic", phrase: input.phrase, accountIndex: input.accountIndex });
      case "preview_private_key": return this.setup.previewImport(input.setupId, { mode: "import_private_key", privateKey: input.privateKey });
      case "stage_mnemonic": return this.setup.stage(input.setupId,
        { mode: "import_mnemonic", phrase: input.phrase, confirmedAddress: input.confirmedAddress, accountIndex: input.accountIndex });
      case "stage_private_key": return this.setup.stage(input.setupId,
        { mode: "import_private_key", privateKey: input.privateKey, confirmedAddress: input.confirmedAddress });
      case "reveal_created": return this.setup.revealCreated(input.setupId);
      case "confirm_backup": return { verified: await this.setup.confirmBackup(input.setupId, input.words) };
      case "confirm_import": await this.setup.confirmImport(input.setupId); return null;
      case "cancel": await this.setup.cancel(input.setupId); return null;
      case "resume": await this.setup.resume(input.setupId); return null;
      case "reveal_ready_mnemonic": return this.setup.revealReadyMnemonic(input.sourceId);
      case "export_secret": return this.setup.exportSecret(input.sourceId, input.format);
      case "cancel_secret_export": this.setup.cancelSecretExport(); return null;
      case "history": {
        requireWallet(this.history, "GENERAL_HISTORY_UNAVAILABLE", "The transfer history is unavailable.");
        const { action: _action, ...query } = input;
        return this.history.read(query);
      }
    }
  }

  /** Parent shutdown drains this child without recursively invoking closeOwner. */
  drainRestore(): Promise<void> { return this.restore.close(); }

  /** Drain the original runtime; neither closure nor a lost reply rewinds durable state. */
  close(): Promise<void> {
    this.closed = true;
    this.manualRequest = undefined;
    this.backup.clear();
    this.draining ??= Promise.resolve().then(async () => { await this.restore.close(); await this.lifetime.closeOwner(); await this.activeDone; });
    this.manualOperation?.controller.abort(); this.backupOperation?.controller.abort(); return this.draining;
  }
}
