import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, parse, sep } from "node:path";
import type { Duplex } from "node:stream";
import { WalletError } from "../domain/errors.js";
import { encodeGeneralAuthRequest, parseGeneralAuthReply, GENERAL_AUTH_MAX_REPLY, type GeneralAuthRequest } from "./generalNativeAuthScope.js";
import type { GeneralTransferPreview } from "./generalTransferIntent.js";
import type { GeneralExportBinding } from "./generalReadySecretExport.js";
import { generalExportAuthenticationScope } from "./generalManagementAuthBindings.js";
export { generalExportAuthenticationScope } from "./generalManagementAuthBindings.js";

export { encodeGeneralAuthRequest, parseGeneralAuthReply, type GeneralAuthRequest } from "./generalNativeAuthScope.js";

export const GENERAL_AUTH_BROKER = "/Library/KoinCodeProtectedWallet/WalletHost.app/Contents/Helpers/GeneralProtectionBroker";
const DEADLINE_MS = 100_000;
const unavailable = () => new WalletError("GENERAL_AUTH_UNAVAILABLE", "Native wallet authentication is unavailable.");

/** Check the first executable path before sending even non-secret scope metadata to it. */
async function executable(): Promise<void> {
  if (process.platform !== "darwin" || process.getuid?.() === 0 || process.geteuid?.() !== process.getuid?.() || !isAbsolute(GENERAL_AUTH_BROKER)) throw unavailable();
  let path = GENERAL_AUTH_BROKER;
  for (;;) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
        (path === GENERAL_AUTH_BROKER ? !info.isFile() : !info.isDirectory())) throw unavailable();
    try { await access(path, constants.W_OK); throw unavailable(); }
    catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || !["EACCES", "EPERM", "EROFS"].includes(String(error.code))) throw unavailable();
    }
    if (path === parse(path).root) break;
    path = dirname(path);
  }
  if (await realpath(GENERAL_AUTH_BROKER) !== GENERAL_AUTH_BROKER || sep !== "/") throw unavailable();
}

type Lifetime = { assertCurrent(): void; invalidate(): void };

/** Owned only by the independent protected host; no injected executable or model-facing method exists. */
export class GeneralNativeAuthentication {
  private pending?: Promise<boolean>;
  private abort?: () => void;
  private closed = false;
  constructor(private readonly lifetime: Lifetime, private readonly locale: "en-US" | "zh-CN") {}

  private current(): void {
    if (this.closed) throw unavailable();
    let result: unknown;
    try { result = this.lifetime.assertCurrent(); } catch { throw unavailable(); }
    if (result !== undefined) {
      if (result instanceof Promise) void result.catch(() => {});
      throw unavailable();
    }
  }

  private fault(): WalletError {
    if (!this.closed) {
      this.closed = true;
      try {
        const result: unknown = this.lifetime.invalidate();
        if (result instanceof Promise) void result.catch(() => {});
      } catch { /* An invalid lifetime never becomes authority. */ }
    }
    return unavailable();
  }

  async authenticateTransfer(preview: GeneralTransferPreview, signal?: AbortSignal): Promise<boolean> {
    return this.authenticate({ action: "manual_transfer", operationDigest: preview.digest,
      accountAddress: preview.accountAddress, manualTransfer: preview }, signal);
  }

  async authenticateExport(binding: GeneralExportBinding, address: string, signal?: AbortSignal): Promise<boolean> {
    return this.authenticate(generalExportAuthenticationScope(binding, address), signal);
  }

  async authenticate(input: { action: string; operationDigest: string; accountAddress: string | null; manualTransfer?: GeneralTransferPreview }, signal?: AbortSignal): Promise<boolean> {
    if (this.pending) throw new WalletError("GENERAL_OPERATION_BUSY", "Native authentication is already pending.");
    const request: GeneralAuthRequest = { format: "koincode-general-auth-request", version: 1, requestId: randomUUID(),
      action: input.action, operationDigest: input.operationDigest, accountAddress: input.accountAddress, locale: this.locale,
      ...(input.manualTransfer ? { manualTransfer: structuredClone(input.manualTransfer) } : {}) };
    encodeGeneralAuthRequest(request);
    try { this.current(); } catch { throw this.fault(); }
    if (signal?.aborted) throw new WalletError("GENERAL_OPERATION_CANCELED", "Native authentication was canceled.");
    // Reserve before filesystem IO; another invocation must not pass admission while it awaits the executable.
    const operation = this.run(request, signal);
    this.pending = operation;
    try { return await operation; }
    catch { throw this.fault(); } finally {
      if (this.pending === operation) this.pending = undefined;
      this.abort = undefined;
    }
  }

  private async run(request: GeneralAuthRequest, signal?: AbortSignal): Promise<boolean> {
    await executable(); this.current();
    if (signal?.aborted) return false;
    return new Promise<boolean>((resolve, reject) => {
      const child = spawn(GENERAL_AUTH_BROKER, ["--authenticate"], { env: { PATH: "/usr/bin:/bin" }, windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "pipe"] });
      const channel = child.stdio[3] as Duplex | null;
      let aborted = false, invalid = !channel, bytes = 0;
      const chunks: Buffer[] = [];
      const abort = () => { aborted = true; channel?.end(); };
      this.abort = abort;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted || this.closed) abort();
      const timer = setTimeout(() => { invalid = true; child.kill("SIGKILL"); }, DEADLINE_MS);
      const bad = () => { invalid = true; child.kill("SIGKILL"); };
      child.stdout?.on("data", bad); child.stderr?.on("data", bad);
      child.once("error", () => { invalid = true; });
      channel?.on("error", () => { if (!aborted) invalid = true; });
      channel?.on("data", (value: Buffer) => {
        bytes += value.length;
        if (bytes > GENERAL_AUTH_MAX_REPLY) bad(); else chunks.push(Buffer.from(value));
      });
      channel?.write(encodeGeneralAuthRequest(request) + "\n", (error) => { if (error && !aborted) invalid = true; });
      child.once("close", (code) => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort); channel?.destroy();
        if (invalid || code !== 0) { reject(unavailable()); return; }
        if (aborted) { resolve(false); return; }
        try {
          this.current();
          resolve(parseGeneralAuthReply(request, Buffer.concat(chunks).toString("utf8")));
        } catch { reject(unavailable()); }
      });
    });
  }

  /** Wait for the original native process to exit; closing never retries an authentication request. */
  async close(): Promise<void> { this.closed = true; this.abort?.(); await this.pending?.catch(() => {}); }
}
