import { z } from "zod";
import { randomUUID } from "node:crypto";
import { WalletError, requireWallet } from "../domain/errors.js";
import type { GeneralBackupPayload } from "./generalBackupPayload.js";
import { generalBackupPassword } from "./generalBackupEnvelope.js";

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const source = z.strictObject({ sourceId: id, address: z.string().regex(/^0x[0-9a-f]{40}$/), sourceType: z.enum(["mnemonic", "private_key"]),
  status: z.enum(["staged", "ready"]), backupVerified: z.boolean() });
const pending = z.strictObject({ setupId: id, mode: z.enum(["create", "import_mnemonic", "import_private_key"]),
  phase: z.enum(["started", "secret_staged", "backup_pending", "canceled"]), createdAt: integer });
const options = z.strictObject({ sourceCommitment: z.string().regex(/^[0-9a-f]{64}$/), sources: z.array(source).max(256), pendingSetups: z.array(pending).max(1000) })
  .refine((value) => new Set(value.sources.map((item) => item.sourceId)).size === value.sources.length &&
    new Set(value.sources.map((item) => item.address)).size === value.sources.length &&
    new Set(value.pendingSetups.map((item) => item.setupId)).size === value.pendingSetups.length);
const result = z.strictObject({ backupId: id, sourceKeyCount: z.number().int().min(0).max(256),
  pendingKeyCount: z.number().int().min(0).max(1000), allReferencedKeys: z.boolean() });
export type GeneralBackupInputOptions = z.infer<typeof options>;
export type GeneralBackupInputResult = z.infer<typeof result>;
export type GeneralBackupInputPort = {
  /** Original runtime snapshot projection only; the commitment never enters the renderer. */
  options(): GeneralBackupInputOptions;
  /** The original coordinator owns native authorization, worker and durable publication. */
  send(selection: GeneralBackupPayload["keyCoverage"], password: string, expectedCommitment: string, signal: AbortSignal): Promise<GeneralBackupInputResult>;
};
type Selection = { requestId: string; snapshot: GeneralBackupInputOptions; sources: Set<string>; pending: Set<string> };
const determinate = new Set(["GENERAL_OPERATION_BUSY", "GENERAL_OPERATION_CANCELED", "GENERAL_BACKUP_HISTORY_CHANGED", "SECRET_ADMISSION_UNAVAILABLE",
  "GENERAL_AUTH_REQUIRED", "GENERAL_BACKUP_INVALID", "GENERAL_CRYPTO_FAILED", "GENERAL_OPERATION_TIMEOUT", "SIGNING_CONTINUITY_UNKNOWN",
  "SIGNING_CONTINUITY_CONFLICT", "SIGNING_JOURNAL_CAPACITY_REACHED", "GENERAL_STORE_UNAVAILABLE", "GENERAL_BACKUP_HISTORY_INVALID"]);
const unavailable = () => new WalletError("GENERAL_BACKUP_UNAVAILABLE", "The protected backup operation is unavailable.");
const uncertain = () => new WalletError("GENERAL_BACKUP_EXPORT_UNCERTAIN", "Check the original backup target before any further export.");

/** Private presentation selection only, never a source, journal, auth or file owner. */
export class GeneralBackupManagement {
  private selection?: Selection;
  private unknown = false;
  constructor(private readonly port?: GeneralBackupInputPort) {}

  options(): unknown {
    this.clear(); if (this.unknown) throw uncertain();
    if (!this.port) return { available: false, requestId: null, sources: [], pendingSetups: [] };
    let snapshot: GeneralBackupInputOptions;
    try { const value = options.safeParse(this.port.options()); if (!value.success) throw unavailable(); snapshot = value.data; }
    catch { throw unavailable(); }
    const requestId = randomUUID();
    this.selection = { requestId, snapshot, sources: new Set(snapshot.sources.map((item) => item.sourceId)), pending: new Set(snapshot.pendingSetups.map((item) => item.setupId)) };
    return { available: true, requestId, sources: structuredClone(snapshot.sources), pendingSetups: structuredClone(snapshot.pendingSetups) };
  }
  private original(requestId: string): Selection {
    if (this.unknown) throw uncertain();
    requireWallet(this.selection?.requestId === requestId && this.port, "GENERAL_OPERATION_CANCELED", "The original backup selection is unavailable.");
    return this.selection;
  }
  select(requestId: string, kind: "source" | "pending", itemId: string, selected: boolean): null {
    const state = this.original(requestId), values = kind === "source" ? state.sources : state.pending;
    requireWallet(kind === "source" ? state.snapshot.sources.some((item) => item.sourceId === itemId) : state.snapshot.pendingSetups.some((item) => item.setupId === itemId),
      "GENERAL_BACKUP_INVALID", "The selected backup material is unavailable.");
    if (selected) values.add(itemId); else values.delete(itemId); return null;
  }
  async export(input: { requestId: string; password: string }, signal: AbortSignal): Promise<GeneralBackupInputResult> {
    let password = input.password; input.password = "";
    try {
      const state = this.original(input.requestId), checked = generalBackupPassword(password); checked.fill(0);
      requireWallet(state.sources.size + state.pending.size > 0, "GENERAL_BACKUP_INVALID", "Select at least one backup material.");
      requireWallet(!signal.aborted, "GENERAL_OPERATION_CANCELED", "The backup operation was canceled.");
      this.selection = undefined;
      try {
        const raw = await this.port!.send({ sourceIds: [...state.sources].sort(), pendingSetupIds: [...state.pending].sort() }, password, state.snapshot.sourceCommitment, signal);
        const parsed = result.safeParse(raw);
        requireWallet(parsed.success && parsed.data.sourceKeyCount === state.sources.size && parsed.data.pendingKeyCount === state.pending.size &&
          parsed.data.allReferencedKeys === (state.sources.size === state.snapshot.sources.length && state.pending.size === state.snapshot.pendingSetups.length),
          "GENERAL_BACKUP_EXPORT_UNCERTAIN", "The original backup publication could not be verified.");
        // Cancellation cannot rewrite an actually verified durable publication.
        return parsed.data;
      } catch (error) {
        if (error instanceof WalletError && determinate.has(error.code)) throw new WalletError(error.code, "The protected backup operation did not complete.");
        this.unknown = true; throw uncertain();
      }
    } finally { password = ""; input.password = ""; }
  }
  clear(): void { this.selection = undefined; }
}
