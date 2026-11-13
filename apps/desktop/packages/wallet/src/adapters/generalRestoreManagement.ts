import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { WalletError, requireWallet } from "../domain/errors.js";
import { generalBackupPassword } from "./generalBackupEnvelope.js";
import { validateGeneralRestorePlan, type GeneralRestorePlan } from "./generalRestorePlan.js";
import type { GeneralRestorePublicationResult } from "./generalRestorePublication.js";

export type GeneralRestorePasswordRequest = { requestId: string; challengeId: string; stage: "prepare" | "publish" };
export type GeneralRestorePasswordPrompt = (signal: AbortSignal) => Promise<string>;
export type GeneralRestoreInputPort = {
  /** Original actor selects the stable file and authenticates before prompting.
   * May inspect an original persisted plan; never stages material or publishes here. */
  prepare(password: GeneralRestorePasswordPrompt, signal: AbortSignal): Promise<GeneralRestorePlan>;
  /** Original actor retains the exact plan and delegates all effects to its coordinator.
   * Authentication, initialization, file and native drainage remain its responsibility. */
  publish(plan: GeneralRestorePlan, password: GeneralRestorePasswordPrompt, signal: AbortSignal): Promise<GeneralRestorePublicationResult>;
};
export type GeneralRestoreInput = { port: GeneralRestoreInputPort; notify(value: GeneralRestorePasswordRequest): void };
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const published = z.strictObject({ recoveryId: uuid, planDigest: hash, profileId: uuid, bindingDigest: hash,
  signingMode: z.enum(["live", "archive_only"]), phase: z.literal("reopened") });
const known = new Set(["GENERAL_AUTH_REQUIRED", "GENERAL_AUTH_REJECTED", "GENERAL_AUTH_TIMEOUT", "GENERAL_OPERATION_TIMEOUT",
  "GENERAL_OPERATION_CANCELED", "GENERAL_RECOVERY_OPERATION_CANCELED", "GENERAL_OPERATION_BUSY", "GENERAL_BACKUP_INVALID", "GENERAL_CRYPTO_FAILED"]);
const canceled = () => new WalletError("GENERAL_RECOVERY_OPERATION_CANCELED", "The original restore interaction was canceled.");
const uncertain = () => new WalletError("GENERAL_RECOVERY_WRITE_UNCERTAIN", "Inspect the original protected restore before another attempt.");
const unavailable = () => new WalletError("GENERAL_RECOVERY_STORE_UNAVAILABLE", "The protected restore interaction is unavailable.");
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}

/** Private UI state only. The genuine parent owns file, bootstrap, Root and publication. */
export class GeneralRestoreManagement {
  private request?: { id: string; plan?: GeneralRestorePlan; prepared: boolean };
  private active?: { requestId: string; controller: AbortController; done: Promise<void> };
  private challenge?: { id: string; requestId: string; deliver(value: string): void; cancel(): void };
  private closed = false;
  private unknown = false;
  private closing?: Promise<void>;
  constructor(private readonly input?: GeneralRestoreInput, private readonly isCurrent: () => boolean = () => true,
    private readonly maximumMs = 180000) {
    requireWallet(typeof isCurrent === "function" && Number.isSafeInteger(maximumMs) && maximumMs > 0 && maximumMs <= 180000,
      "GENERAL_RECOVERY_STORE_UNAVAILABLE", "The restore interaction lifetime is invalid.");
  }
  private current(): void {
    let current = false; try { const value: unknown = this.isCurrent(); if (value instanceof Promise) void value.catch(() => {}); current = value === true; } catch { /* Missing resources fail closed. */ }
    if (this.closed || !current) throw canceled();
    if (this.unknown) throw uncertain();
  }
  options() {
    this.current(); requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "The original restore interaction is running.");
    this.request = undefined;
    if (!this.input) return { available: false, requestId: null };
    requireWallet(typeof this.input.port?.prepare === "function" && typeof this.input.port.publish === "function" && typeof this.input.notify === "function",
      "GENERAL_RECOVERY_STORE_UNAVAILABLE", "The original restore ports are unavailable.");
    const requestId = randomUUID(); this.request = { id: requestId, prepared: false }; return { available: true, requestId };
  }
  matches(requestId: string): boolean { return this.active?.requestId === requestId; }
  password(input: { requestId: string; challengeId: string; password: string }): null {
    let password = input.password; input.password = "";
    try {
      this.current();
      requireWallet(this.challenge?.requestId === input.requestId && this.challenge.id === input.challengeId && this.active?.requestId === input.requestId &&
        !this.active.controller.signal.aborted, "GENERAL_RECOVERY_OPERATION_CANCELED", "The original password challenge is unavailable.");
      const checked = generalBackupPassword(password); checked.fill(0);
      this.challenge.deliver(password); return null;
    } finally { password = ""; input.password = ""; }
  }
  cancel(requestId: string): null {
    requireWallet(this.matches(requestId), "GENERAL_RECOVERY_OPERATION_CANCELED", "The original restore interaction is unavailable.");
    this.active!.controller.abort(); this.challenge?.cancel(); return null;
  }
  prepare(requestId: string): Promise<unknown> { return this.run(requestId, "prepare"); }
  publish(requestId: string): Promise<unknown> { return this.run(requestId, "publish"); }
  private async run(requestId: string, stage: "prepare" | "publish"): Promise<unknown> {
    this.current();
    requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "The original restore interaction is running.");
    const selection = this.request;
    requireWallet(this.input && selection?.id === requestId && (stage === "prepare" ? !selection.prepared : !!selection.plan),
      "GENERAL_RECOVERY_OPERATION_CANCELED", "The original restore selection is unavailable.");
    if (stage === "prepare") selection.prepared = true;
    const plan = selection.plan; selection.plan = undefined;
    const controller = new AbortController(); let finish!: () => void;
    const operation = { requestId, controller, done: new Promise<void>((resolve) => { finish = resolve; }) }; this.active = operation;
    let last = performance.now(); const expires = last + this.maximumMs;
    const timer = setTimeout(() => controller.abort(), this.maximumMs); timer.unref();
    let prompted = false, admitted = false;
    const current = () => {
      this.current(); const now = performance.now();
      if (!Number.isFinite(now) || !Number.isFinite(expires) || now < last || now >= expires) controller.abort(); last = now;
      if (controller.signal.aborted) throw canceled();
    };
    const password: GeneralRestorePasswordPrompt = async (parent) => {
      current(); requireWallet(parent instanceof AbortSignal && !parent.aborted && !prompted, "GENERAL_RECOVERY_OPERATION_CANCELED", "The original password request is unavailable.");
      prompted = true; const signal = AbortSignal.any([parent, controller.signal]);
      const value = await new Promise<string>((resolve, reject) => {
        const challengeId = randomUUID();
        const clear = () => { signal.removeEventListener("abort", abort); if (this.challenge?.id === challengeId) this.challenge = undefined; };
        const abort = () => { clear(); reject(canceled()); };
        this.challenge = { id: challengeId, requestId, deliver: (value) => { clear(); resolve(value); }, cancel: abort };
        signal.addEventListener("abort", abort, { once: true });
        try { const result: unknown = this.input!.notify(Object.freeze({ requestId, challengeId, stage }));
          if (result !== undefined) { if (result instanceof Promise) void result.catch(() => {}); throw unavailable(); }
          current();
        } catch { clear(); reject(unavailable()); }
      });
      current(); if (parent.aborted) throw canceled(); return value;
    };
    try {
      current(); admitted = true;
      if (stage === "prepare") {
        const prepared = freeze(validateGeneralRestorePlan(await this.input.port.prepare(password, controller.signal))); current();
        selection.plan = prepared;
        const selected = new Set(prepared.keyRefs);
        return { requestId, backupId: prepared.backupId, mode: prepared.mode, phase: prepared.phase,
          signingContinuity: prepared.target.signingContinuity, selectedKeyCount: selected.size,
          accounts: prepared.target.state.sources.map((source) => ({ address: source.address, sourceType: source.sourceType,
            status: source.status, materialSelected: selected.has(source.keyRef) })) };
      }
      const parsed = published.safeParse(await this.input.port.publish(plan!, password, controller.signal));
      if (!parsed.success || parsed.data.recoveryId !== plan!.recoveryId || parsed.data.planDigest !== plan!.planDigest || parsed.data.profileId !== plan!.target.profileId ||
        (parsed.data.signingMode === "live" && (plan!.mode !== "same_installation" || plan!.target.signingContinuity !== "complete"))) throw uncertain();
      current(); this.request = undefined;
      return { recoveryId: parsed.data.recoveryId, signingMode: parsed.data.signingMode, phase: parsed.data.phase };
    } catch (error) {
      this.request = undefined;
      // A late publication may have changed the active binding; never call it a rollback.
      if (admitted && (stage === "publish" && controller.signal.aborted || !(error instanceof WalletError && known.has(error.code)))) {
        this.unknown = true; throw uncertain();
      }
      if (error instanceof WalletError && known.has(error.code)) throw new WalletError(error.code, "The protected restore interaction did not complete.");
      throw unavailable();
    } finally {
      this.challenge?.cancel(); clearTimeout(timer); if (this.active === operation) this.active = undefined; finish();
    }
  }
  /** Wait for the real port, not just an aborted password waiter. Unknown effects retain parent ownership. */
  close(): Promise<void> {
    this.closed = true; this.request = undefined; this.active?.controller.abort(); this.challenge?.cancel();
    this.closing ??= (this.active?.done ?? Promise.resolve()).then(() => { if (this.unknown) throw uncertain(); });
    return this.closing;
  }
}
