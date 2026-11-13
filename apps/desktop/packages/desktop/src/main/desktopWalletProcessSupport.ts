import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isWalletMessage } from "./desktopWalletProtocol.js";

export interface WalletChild {
  postMessage(message: unknown, transfer?: Electron.MessagePortMain[]): void;
  kill(): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
}
export interface PendingWalletReply {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  progress?: number;
}
export class DesktopWalletError extends Error {
  constructor(readonly code: string) { super(`Wallet service: ${code}`); }
}
export function closeWalletPort(port: Electron.MessagePortMain | undefined): void {
  try { port?.close(); }
  catch { /* A failed close cannot certify termination or prevent the kill attempt. */ }
}
export type WalletDiagnosticSink = (message: string, details: Record<string, string | number | null>) => void;
const consoleDiagnostics: WalletDiagnosticSink = (message, details) => console.warn(message, details);
/** Only a fixed command name may reach diagnostics; anything else is reported as unknown. */
const commandName = (body: Record<string, unknown>) => typeof body.type === "string" && /^[a-z-]{1,32}$/.test(body.type) ? body.type : "unknown";

export function sendWalletCommand(child: WalletChild | undefined, pending: Map<string, PendingWalletReply>,
  body: Record<string, unknown>, transfer: Electron.MessagePortMain[] | undefined, timeout: number,
  quarantine: (child: WalletChild, cause: string) => void, current: () => WalletChild | undefined): Promise<unknown> {
  if (!child || !isWalletMessage(body) || pending.size >= 32)
    return Promise.reject(new DesktopWalletError("WALLET_UNAVAILABLE"));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); quarantine(child, `command_timeout:${commandName(body)}`); reject(new DesktopWalletError("WALLET_TIMEOUT")); }, timeout);
    timer.unref(); pending.set(id, { resolve, reject, timer, ...(["storage-plan", "storage-apply"].includes(String(body.type)) ? { progress: 0 } : {}) });
    try { child.postMessage({ ...body, id }, transfer); }
    catch {
      clearTimeout(timer); pending.delete(id); quarantine(child, `command_send_failed:${commandName(body)}`);
      reject(new DesktopWalletError(current() === child ? "WALLET_LOCK_UNCERTAIN" : "WALLET_PROCESS_EXITED"));
    }
  });
}

/** Startup diagnostics contain only the trusted mode and bounded public error code. */
export function reportWalletStartupFailure(mode: string, error: unknown, sink: WalletDiagnosticSink = consoleDiagnostics): void {
  try {
    sink("[wallet] Profile startup failed.", {
      mode, code: error instanceof DesktopWalletError ? error.code : "WALLET_UNAVAILABLE",
    });
  } catch { /* A failed diagnostic sink cannot change startup cleanup. */ }
}

/** Exit diagnostics must never interrupt pending-request rejection and cleanup. The cause is a fixed quarantine label. */
export function reportWalletExit(mode: string, code: number, reason: "unexpected" | "stopped" | "quarantined", pendingRequests: number,
  cause?: string, sink: WalletDiagnosticSink = consoleDiagnostics): void {
  try {
    sink("[wallet] Service exited.", { mode, exitCode: Number.isSafeInteger(code) ? code : null, reason, pendingRequests,
      ...(cause ? { cause } : {}) });
  } catch { /* A failed diagnostic sink cannot change the service lifetime. */ }
}

export function walletRuntimeAssetsAvailable(modulePath: string): boolean {
  const directory = dirname(modulePath);
  try {
    return [modulePath, "keyCrypto.js", "backup-crypto.js", "crypto-worker.mjs",
      "inspectResponseJob.js", "response-worker.mjs"].every((name, index) => {
      const stat = statSync(index === 0 ? name : join(directory, name));
      return stat.isFile() && stat.size > 0;
    });
  } catch { return false; }
}

/** A dedicated trusted-window port shares the existing utility and its actual lifetime. */
export async function openWalletPrivateManagementPort(prepare: () => Promise<void>, create: () => Electron.MessageChannelMain,
  send: (body: Record<string, unknown>, ports: Electron.MessagePortMain[]) => Promise<unknown>): Promise<Electron.MessagePortMain> {
  await prepare(); const channel = create();
  try { await send({ type: "general-connect" }, [channel.port2]); return channel.port1; }
  catch (error) { closeWalletPort(channel.port1); closeWalletPort(channel.port2); throw error; }
}

/** Maintenance uses the same utility owner; only a native UI confirmation admits writes. */
export async function migrateWalletStorage(stop: () => Promise<void>, start: () => Promise<void>,
  send: (body: Record<string, unknown>) => Promise<unknown>,
  confirm: (summary: { records: number; domains: number }) => Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
  const check = () => { if (signal?.aborted) throw new DesktopWalletError("WALLET_INTERACTION_CANCELED"); };
  const cancel = () => { void stop().catch(() => {}); };
  await stop();
  check(); signal?.addEventListener("abort", cancel, { once: true });
  try {
    check(); await start(); check();
    const plan = await send({ type: "storage-plan" }) as { token: string; records: number; domains: number };
    if (!plan || !/^[0-9a-f-]{36}$/.test(plan.token) || !Number.isSafeInteger(plan.records) || plan.records < 1 ||
        plan.records > 4096 || !Number.isSafeInteger(plan.domains) || plan.domains < 1 || plan.domains > 2)
      throw new DesktopWalletError("WALLET_STORAGE_MIGRATION_CONFLICT");
    check();
    if (!await confirm({ records: plan.records, domains: plan.domains })) return false;
    check();
    await send({ type: "storage-apply", token: plan.token });
    return true;
  } finally { signal?.removeEventListener("abort", cancel); await stop(); }
}

export function failWalletReplies(pending: Map<string, PendingWalletReply>, code: string): void {
  for (const reply of pending.values()) { clearTimeout(reply.timer); reply.reject(new DesktopWalletError(code)); }
  pending.clear();
}

/** Only completed, bounded maintenance steps extend the inactivity timeout. */
export function receiveStorageProgress(message: unknown, pending: Map<string, PendingWalletReply>): boolean {
  if (!isWalletMessage(message) || message.type !== "storage-progress") return false;
  if (typeof message.id !== "string" || !Number.isSafeInteger(message.sequence)) return true;
  const reply = pending.get(message.id);
  if (reply?.progress === undefined || message.sequence !== reply.progress + 1 || Number(message.sequence) > 4104) return true;
  reply.progress = Number(message.sequence); reply.timer.refresh();
  return true;
}
