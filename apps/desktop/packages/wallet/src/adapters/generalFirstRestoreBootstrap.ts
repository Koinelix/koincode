import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { WalletError, requireWallet } from "../domain/errors.js";
import { inspectGeneralBackupEnvelope, generalBackupPassword } from "./generalBackupEnvelope.js";
import { runGeneralBackupPreviewTask } from "./generalCryptoTask.js";
import { prepareGeneralFirstRestorePlan, validateGeneralFirstRestoreIdentity, type GeneralFirstRestoreIdentity, type GeneralFirstRestorePrepared } from "./generalFirstRestorePlan.js";
import type { GeneralSessionInput } from "./generalSessionChannel.js";

export type GeneralFirstRestoreBegin = Extract<GeneralSessionInput, { command: "begin" }> & {
  body: { kind: "bootstrap_restore"; ciphertextDigest: string; byteLength: number; locale: "en-US" | "zh-CN" } };
type NativeScope = { isCurrent(): boolean; close(): Promise<void> };
export type GeneralFirstRestorePorts = {
  /** Original native actor only; binds the existing begin and real policy.
   * Reject only after a known terminal, or retain unknown native ownership. */
  authorize(begin: GeneralFirstRestoreBegin, expiresAt: number, signal: AbortSignal): Promise<NativeScope>;
  /** Original protected UI only, called after actual bootstrap authentication. */
  requestPassword(signal: AbortSignal): Promise<string>;
};
const unavailable = () => new WalletError("GENERAL_RECOVERY_STORE_UNAVAILABLE", "The original protected restore bootstrap is unavailable.");
const determinateAuth = new Set(["GENERAL_AUTH_REQUIRED", "GENERAL_AUTH_REJECTED", "GENERAL_AUTH_TIMEOUT", "GENERAL_OPERATION_TIMEOUT",
  "GENERAL_OPERATION_CANCELED", "GENERAL_RECOVERY_OPERATION_CANCELED"]);
const allowed = new Set([...determinateAuth, "GENERAL_OPERATION_BUSY", "GENERAL_BACKUP_INVALID", "GENERAL_RESTORE_PLAN_INVALID", "GENERAL_CRYPTO_FAILED", "GENERAL_RECOVERY_STORE_UNAVAILABLE"]);
function truth(callback: () => boolean): boolean {
  try { const result: unknown = callback(); if (result instanceof Promise) void result.catch(() => {}); return result === true; }
  catch { return false; }
}

/** One private Host substage. The actual parent retains genuine code/profile,
 * original child/window/peer, Root fresh channel, locks and selected stable fd.
 * This class neither proves those resources nor grants ready/material/signing. */
export class GeneralFirstRestoreBootstrap {
  private readonly identity: GeneralFirstRestoreIdentity;
  private active?: { controller: AbortController; done: Promise<void> };
  private attempted = false;
  private closed = false;
  private closing?: Promise<void>;
  private closeFailure?: WalletError;
  private retainedScope?: NativeScope;
  private nativeClose?: () => Promise<void>;
  constructor(identity: GeneralFirstRestoreIdentity, private readonly locale: "en-US" | "zh-CN", private readonly isCurrent: () => boolean,
    private readonly maximumMs = 180000) {
    this.identity = validateGeneralFirstRestoreIdentity(identity);
    requireWallet(typeof process.geteuid === "function" && this.identity.uid === process.geteuid() && this.identity.uid !== 0 &&
      (locale === "en-US" || locale === "zh-CN") && typeof isCurrent === "function" &&
      Number.isSafeInteger(maximumMs) && maximumMs > 0 && maximumMs <= 180000,
      "GENERAL_RECOVERY_STORE_UNAVAILABLE", "The original restore bootstrap context is unavailable.");
  }

  async prepare(backup: string, ports: GeneralFirstRestorePorts, parent?: AbortSignal): Promise<GeneralFirstRestorePrepared> {
    requireWallet(!this.closed && !this.attempted && !this.active, "GENERAL_OPERATION_BUSY", "The original restore bootstrap has already been attempted.");
    requireWallet(parent === undefined || parent instanceof AbortSignal, "GENERAL_RECOVERY_STORE_UNAVAILABLE", "The original restore cancellation signal is unavailable.");
    this.attempted = true;
    const controller = new AbortController(), signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    let finish!: () => void; const done = new Promise<void>((resolve) => { finish = resolve; });
    const operation = { controller, done }; this.active = operation;
    let lastTime = performance.now(); const expiresAt = lastTime + this.maximumMs;
    const timer = setTimeout(() => controller.abort(), this.maximumMs); timer.unref();
    let scope: NativeScope | undefined, authorizationStarted = false, authorizationReturned = false;
    let password = "", job: { operation: "preview_backup"; backup: string; password: string } | undefined;
    const current = () => {
      const now = performance.now();
      if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || now < lastTime || now >= expiresAt) controller.abort();
      lastTime = now;
      requireWallet(!this.closed && !signal.aborted, "GENERAL_RECOVERY_OPERATION_CANCELED", "The original restore bootstrap was canceled.");
      requireWallet(truth(this.isCurrent) && (!scope || truth(() => scope!.isCurrent())) && !this.closed && !signal.aborted,
        "GENERAL_RECOVERY_STORE_UNAVAILABLE", "The original restore bootstrap resources changed.");
    };
    let result: GeneralFirstRestorePrepared | undefined, failure: WalletError | undefined;
    try {
      current(); inspectGeneralBackupEnvelope(backup); current();
      requireWallet(ports && typeof ports.authorize === "function" && typeof ports.requestPassword === "function",
        "GENERAL_RECOVERY_STORE_UNAVAILABLE", "The original restore bootstrap ports are unavailable.");
      const begin: GeneralFirstRestoreBegin = Object.freeze({ command: "begin", operationId: randomUUID(), requestId: randomUUID(),
        body: Object.freeze({ kind: "bootstrap_restore", ciphertextDigest: createHash("sha256").update(backup, "ascii").digest("hex"),
          byteLength: Buffer.byteLength(backup, "ascii"), locale: this.locale }) });
      current(); authorizationStarted = true;
      const authorized = await ports.authorize(begin, expiresAt, signal); authorizationReturned = true;
      if (authorized && typeof authorized.close === "function") { this.retainedScope = authorized; this.nativeClose = authorized.close.bind(authorized); }
      if (!this.retainedScope) { this.closed = true; controller.abort(); this.closeFailure = unavailable(); }
      requireWallet(this.retainedScope && typeof authorized.isCurrent === "function", "GENERAL_RECOVERY_STORE_UNAVAILABLE", "The native bootstrap scope is unavailable.");
      scope = this.retainedScope; current(); password = await ports.requestPassword(signal); current();
      const checked = generalBackupPassword(password); checked.fill(0);
      job = { operation: "preview_backup", backup, password }; password = "";
      const preview = await runGeneralBackupPreviewTask(job, signal); current();
      result = prepareGeneralFirstRestorePlan(preview, this.identity); current();
    } catch (error) {
      if (authorizationStarted && !authorizationReturned && !(error instanceof WalletError && determinateAuth.has(error.code))) {
        this.closed = true; controller.abort(); this.closeFailure = unavailable();
      }
      failure = error instanceof WalletError && allowed.has(error.code) ? new WalletError(error.code, "The original protected restore bootstrap did not complete.") : unavailable();
    } finally {
      backup = ""; password = ""; if (job) { job.backup = ""; job.password = ""; }
      try {
        await this.drainScope(); scope = undefined;
      } catch {
        this.closed = true; controller.abort(); this.closeFailure = unavailable(); failure = this.closeFailure;
      }
      if (!failure) {
        try { current(); }
        catch (error) { failure = error instanceof WalletError && allowed.has(error.code) ? new WalletError(error.code, "The original restore bootstrap expired before delivery.") : unavailable(); }
      }
      clearTimeout(timer);
      if (!this.closeFailure && this.active === operation) this.active = undefined;
      finish();
    }
    if (failure) throw failure;
    return result!;
  }

  private async drainScope(): Promise<void> {
    if (!this.retainedScope) return;
    const closed: unknown = await this.nativeClose!();
    if (closed !== undefined) throw unavailable();
    this.retainedScope = undefined; this.nativeClose = undefined;
  }

  /** Only this substage drains here. The genuine parent owns fd/Root/UID release.
   * Unknown native closure is retained and never retried by this method. */
  close(): Promise<void> {
    this.closed = true; this.active?.controller.abort();
    this.closing ??= (this.active?.done ?? Promise.resolve()).then(() => { if (this.closeFailure) throw this.closeFailure; });
    return this.closing;
  }
}
