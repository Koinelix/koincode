import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import type { DesktopServiceRequestContext } from "./desktopWalletHostTypes.js";
import type { ServiceCredentialStore, ServiceCredentialView } from "./desktopServiceCredentials.js";
import { DesktopWalletClientPayments, type DesktopWalletClientQuote } from "./desktopWalletClientPayments.js";
import { clientPresentation, verifiedImageType, collectPaymentSecrets } from "./desktopWalletClientPresentation.js";
import { walletClientPaymentLimitSchema, type WalletClientPaymentLimit, type WalletPaymentActivity } from "@fcode/shared";
import { codeOf, failure } from "./desktopWalletHostIdentity.js";

const MAX_PROTOCOL_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACTS = 8;
const FORCE_KILL_MS = 5000;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Input = { script: string; runtime: "python3" | "node"; args: string[]; paymentLimit?: WalletClientPaymentLimit };

function input(value: Record<string, unknown>): Input {
  if (Object.keys(value).some(key => !["script", "runtime", "args", "paymentLimit"].includes(key)) ||
      typeof value.script !== "string" || value.script.length > 8192 || !isAbsolute(value.script) ||
      !["python3", "node"].includes(value.runtime as string) ||
      (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 64 ||
        value.args.some(arg => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0")))))
    throw failure("WALLET_CLIENT_INPUT_INVALID");
  const paymentLimit = value.paymentLimit === undefined ? undefined : walletClientPaymentLimitSchema.safeParse(value.paymentLimit);
  if (paymentLimit && !paymentLimit.success) throw failure("WALLET_CLIENT_INPUT_INVALID");
  return { script: value.script, runtime: value.runtime as Input["runtime"], args: (value.args ?? []) as string[],
    ...(paymentLimit?.success ? { paymentLimit: paymentLimit.data } : {}) };
}

/** Executes any independent local client. The wallet protocol and files are business-agnostic. */
export class DesktopWalletClientRunner {
  constructor(private readonly options: {
    directory: string;
    credentials?: ServiceCredentialStore;
    nodeExecutable: string;
    paymentActivity?: {
      quote(context: DesktopServiceRequestContext, quote: Readonly<DesktopWalletClientQuote>, invocationId: string): Promise<void>;
      hasRecorded?(context: DesktopServiceRequestContext, quote: Readonly<DesktopWalletClientQuote>, invocationId: string): boolean;
      attachResult?(context: DesktopServiceRequestContext, quote: Readonly<DesktopWalletClientQuote>, invocationId: string, result: NonNullable<WalletPaymentActivity["result"]>): Promise<boolean>;
      update(context: DesktopServiceRequestContext, quote: Readonly<DesktopWalletClientQuote>, invocationId: string,
        status: WalletPaymentActivity["status"]): Promise<void>;
      unknown(context: DesktopServiceRequestContext, result?: NonNullable<WalletPaymentActivity["result"]>): Promise<void>;
      closeQuote?(context: DesktopServiceRequestContext, quote: Readonly<DesktopWalletClientQuote>, invocationId: string,
        reason: "expired" | "closed"): Promise<void>;
    };
  }) {}

  async execute(context: DesktopServiceRequestContext): Promise<unknown> {
    const request = input(context.input.input);
    const script = await realpath(request.script), info = await lstat(request.script);
    if (script !== resolve(request.script) || !info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
      throw failure("WALLET_CLIENT_SCRIPT_INVALID");
    if ((request.runtime === "python3" && !script.endsWith(".py")) ||
        (request.runtime === "node" && !/\.(?:mjs|cjs|js)$/.test(script))) throw failure("WALLET_CLIENT_SCRIPT_INVALID");
    this.assertCurrent(context);
    const root = join(this.options.directory, hash(JSON.stringify([
      context.agent.workspaceKey, context.input.invocation.sessionId, script])));
    const output = join(root, "results", randomUUID());
    const state = join(root, "state");
    await mkdir(output, { recursive: true, mode: 0o700 });
    await mkdir(state, { recursive: true, mode: 0o700 });
    if (await realpath(root) !== root || await realpath(output) !== output || await realpath(state) !== state)
      throw failure("UNSAFE_STORAGE_PATH");
    const lifetime = new AbortController();
    const scoped = { ...context, signal: AbortSignal.any([context.signal, lifetime.signal]),
      isCurrent: () => !lifetime.signal.aborted && context.isCurrent() };
    const credentials: (ServiceCredentialView & { url: string })[] = [];
    const sensitive: string[] = [];
    const targets = new Set<string>();
    const activities = new Map<string, { invocationId: string; quote: Readonly<DesktopWalletClientQuote> }>();
    let unrecordedQuoteFailure = false;
    const closedQuotes = new Map<string, "expired" | "closed">();
    const trackTarget = (url: string) => {
      this.assertCurrent(scoped);
      if (targets.has(url)) return;
      if (targets.size >= MAX_ARTIFACTS) throw failure("SERVICE_OUTBOUND_DENIED");
      targets.add(url);
    };
    const payments = new DesktopWalletClientPayments(scoped, async () => {
      for (const credential of credentials)
        await this.options.credentials!.assertCurrent(credential.ref, credential.url, credential.version);
    }, async quote => {
      if (!this.options.paymentActivity) throw failure("PAYMENT_QUOTE_DISPLAY_UNAVAILABLE");
      const invocationId = quote.invocationId;
      try {
        await this.options.paymentActivity.quote(scoped, quote, invocationId);
      } catch (error) {
        if (this.options.paymentActivity.hasRecorded?.(scoped, quote, invocationId))
          activities.set(quote.paymentId, { invocationId, quote });
        else unrecordedQuoteFailure = true;
        throw error;
      }
      activities.set(quote.paymentId, { invocationId, quote });
    }, (action, signal) => credentials.length ? this.options.credentials!.withCurrentMany([...credentials], action, signal) : action(signal),
    request.paymentLimit);
    const call = async (method: string, params: Record<string, unknown>) => {
      this.assertCurrent(scoped);
      if (method === "context") {
        if (Object.keys(params).length) throw failure("INVALID_REQUEST");
        return { protocolVersion: 1, stateDirectory: state, outputDirectory: output,
          taskId: hash(JSON.stringify([context.agent.workspaceKey, context.input.invocation.sessionId, context.input.invocation.turnId])) };
      }
      if (method === "credential.read") {
        if (Object.keys(params).join(",") !== "url" || typeof params.url !== "string" || !this.options.credentials)
          throw failure("SERVICE_CREDENTIAL_NOT_FOUND");
        const url = new URL(params.url);
        const matches = (await this.options.credentials.list()).filter(entry => entry.origin === url.origin && entry.path === url.pathname);
        if (matches.length !== 1) throw failure("SERVICE_CREDENTIAL_NOT_FOUND");
        trackTarget(params.url);
        const entry = matches[0]!;
        const secret = await this.options.credentials.resolve(entry.ref, params.url, entry.version);
        sensitive.push(secret);
        this.assertCurrent(scoped);
        credentials.push({ ...entry, url: params.url });
        // Optional host credentials are independent of wallet custody and payment APIs.
        return { secret, credentialTag: hash(JSON.stringify([entry.ref, entry.version])) };
      }
      if (method === "prepare_payment" && object(params.payment) && typeof params.payment.url === "string") {
        trackTarget(params.payment.url);
        const applicable = credentials.filter(credential => credential.url === (params.payment as Record<string, unknown>).url);
        const tag = params.payment.credentialTag;
        if (applicable.length) {
          if (typeof tag !== "string" || !applicable.some(credential =>
            hash(JSON.stringify([credential.ref, credential.version])) === tag))
            throw failure("SERVICE_CREDENTIAL_NOT_FOUND");
        } else if (tag !== undefined && tag !== null) {
          throw failure("SERVICE_CREDENTIAL_NOT_FOUND");
        }
      }
      let result: unknown;
      try { result = await payments.call(method, params); }
      catch (error) {
        if (method === "authorize_payment" && typeof params.paymentId === "string")
          closedQuotes.set(params.paymentId, codeOf(error) === "QUOTE_EXPIRED" ? "expired" : "closed");
        throw error;
      }
      if (method === "authorize_payment") collectPaymentSecrets(result, sensitive);
      if (method === "authorize_payment" && typeof params.paymentId === "string") {
        const entry = activities.get(params.paymentId);
        if (!entry || !this.options.paymentActivity) throw failure("PAYMENT_CONTEXT_REQUIRED");
        await this.options.paymentActivity.update(scoped, entry.quote, entry.invocationId, "pending");
      }
      if ((method === "get_payment" || method === "reconcile_payment") && typeof params.paymentId === "string") {
        const entry = activities.get(params.paymentId);
        if (entry && this.options.paymentActivity) {
          const payment = await payments.lookupPayment(params.paymentId, entry.quote.clientOperationId);
          await this.options.paymentActivity.update(scoped, entry.quote, entry.invocationId,
            payment.paymentStatus === "confirmed" ? "confirmed" :
              ["signed", "submitted", "observed"].includes(payment.paymentStatus) ? "pending" : "unknown");
        }
      }
      return result;
    };
    try {
      const result = await runClient(request, this.options.nodeExecutable, output, context.signal, call,
        () => lifetime.abort(failure("WALLET_CLIENT_CLOSED")));
      this.assertCurrent(context);
      const receipt = await clientResult(result, output, request.args, sensitive);
      let attached = false;
      const presentation = receipt.presentation || receipt.artifacts.length ? {
        version: 1 as const, ...(receipt.presentation ? { clientPrompt: receipt.presentation.clientPrompt } : {}),
        artifacts: receipt.artifacts.map(a => ({ artifactId: a.sha256, name: a.name, bytes: a.bytes,
          ...(a.verifiedMediaType ? { verifiedMediaType: a.verifiedMediaType } : {}) })),
      } : undefined;
      if (typeof receipt.paymentId === "string" && typeof receipt.operationId === "string") {
        const entry = activities.get(receipt.paymentId);
        if (!entry || !payments.ownsPayment(receipt.paymentId, receipt.operationId)) {
          delete receipt.paymentId;
        } else if (presentation && activities.size === 1 && receipt.artifacts.length === 1 && !unrecordedQuoteFailure) {
          attached = await this.options.paymentActivity?.attachResult?.(context, entry.quote, entry.invocationId, presentation) ?? false;
        }
      }
      // A client configuration error before any quote is not an unknown wallet payment.
      if ((unrecordedQuoteFailure || (presentation && !attached)) && this.options.paymentActivity)
        await this.options.paymentActivity.unknown(context, presentation);
      delete receipt.presentation;
      return receipt;
    } finally {
      lifetime.abort();
      try { await payments.close(); }
      finally {
        for (const [paymentId, entry] of activities) {
          try { await this.options.paymentActivity?.closeQuote?.(context, entry.quote, entry.invocationId,
            closedQuotes.get(paymentId) ?? "closed"); }
          catch { /* Display cleanup cannot replace the original payment result. */ }
        }
      }
    }
  }

  private assertCurrent(context: DesktopServiceRequestContext) {
    if (context.signal.aborted || !context.isCurrent()) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
  }
}

function stop(child: ChildProcess, force: boolean) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", ...(force ? ["/F"] : [])],
      { stdio: "ignore", windowsHide: true });
    killer.on("error", () => child.kill(force ? "SIGKILL" : "SIGTERM"));
  } else {
    try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
    catch { child.kill(force ? "SIGKILL" : "SIGTERM"); }
  }
}

async function runClient(request: Input, nodeExecutable: string, cwd: string, signal: AbortSignal,
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>, onClosed: () => void): Promise<unknown> {
  signal.throwIfAborted();
  const child = spawn(request.runtime === "node" ? nodeExecutable : "python3",
    [...(request.runtime === "python3" ? ["-B"] : []), request.script, ...request.args], {
    cwd, shell: false, detached: process.platform !== "win32", windowsHide: true,
    env: { ...clientEnvironment(), ...(request.runtime === "node" ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const pipe = child.stdio[3] as Duplex;
  const work = new Set<Promise<void>>();
  let buffer = Buffer.alloc(0), stdout = Buffer.alloc(0), lastId = 0, count = 0;
  let failureCode: string | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    failureCode ??= signal.aborted ? "WALLET_REQUEST_CANCELED" : "WALLET_CLIENT_PROTOCOL_INVALID";
    onClosed(); stop(child, false);
    killTimer ??= setTimeout(() => stop(child, true), FORCE_KILL_MS);
    killTimer.unref();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  pipe.on("error", abort);
  pipe.once("end", onClosed);
  pipe.once("close", onClosed);
  child.once("exit", () => {
    onClosed();
    if (process.platform !== "win32") stop(child, true);
  });
  child.stdout!.on("data", (bytes: Buffer) => {
    if (stdout.length + bytes.length > MAX_OUTPUT_BYTES) abort();
    else stdout = Buffer.concat([stdout, bytes]);
  });
  child.stderr!.on("data", (bytes: Buffer) => { if ((count += bytes.length) > MAX_OUTPUT_BYTES) abort(); });
  pipe.on("data", (bytes: Buffer) => {
    if (buffer.length + bytes.length > MAX_PROTOCOL_BYTES) { abort(); return; }
    buffer = Buffer.concat([buffer, bytes]);
    for (let end; (end = buffer.indexOf(10)) >= 0;) {
      const line = buffer.subarray(0, end).toString("utf8"); buffer = buffer.subarray(end + 1);
      let value: Record<string, unknown>;
      try { value = JSON.parse(line) as Record<string, unknown>; }
      catch { abort(); return; }
      if (!object(value) || Object.keys(value).sort().join(",") !== "id,method,params,version" ||
          value.version !== 1 || value.id !== lastId + 1 || typeof value.method !== "string" || !object(value.params) || work.size >= 8) {
        abort(); return;
      }
      const id = value.id as number; lastId = id;
      if (lastId > 128) { abort(); return; }
      // Parse and admit IDs in order; execute independently so cancellation cannot queue behind approval.
      const job = (async () => {
        if (failureCode || signal.aborted) return;
        try {
          const result = await call(value.method as string, value.params as Record<string, unknown>);
          if (!failureCode && !signal.aborted && !pipe.destroyed)
            pipe.write(JSON.stringify({ version: 1, id, ok: true, value: result }) + "\n");
        } catch (error) {
          if (!pipe.destroyed) pipe.write(JSON.stringify({ version: 1, id, ok: false, code: codeOf(error) }) + "\n");
        }
        if (pipe.writableLength > MAX_PROTOCOL_BYTES) abort();
      })().catch(abort).finally(() => { work.delete(job); });
      work.add(job);
    }
  });
  try {
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", () => { onClosed(); reject(failure("WALLET_CLIENT_START_FAILED")); });
      child.once("close", code => { onClosed(); resolveExit(code); });
    });
    await Promise.allSettled(work);
    if (failureCode || signal.aborted) throw failure(failureCode ?? "WALLET_REQUEST_CANCELED");
    if (code !== 0) throw failure("WALLET_CLIENT_FAILED");
    try { return JSON.parse(stdout.toString("utf8")); }
    catch { throw failure("WALLET_CLIENT_RESULT_INVALID"); }
  } finally {
    signal.removeEventListener("abort", abort);
    if (killTimer) clearTimeout(killTimer);
    pipe.destroy(); stdout.fill(0); buffer.fill(0);
  }
}

async function clientResult(value: unknown, directory: string, args: readonly string[], sensitive: readonly string[]) {
  if (!object(value) || Object.keys(value).some(key => !["status", "diagnosticCode", "operationId", "paymentId", "artifacts", "presentation"].includes(key)) ||
      !["completed", "recovered", "pending", "failed"].includes(value.status as string) ||
      (value.diagnosticCode !== undefined && (typeof value.diagnosticCode !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value.diagnosticCode))) ||
      ["operationId", "paymentId"].some(key => value[key] !== undefined && (typeof value[key] !== "string" || !/^[0-9a-f-]{36}$/.test(value[key] as string))) ||
      !Array.isArray(value.artifacts) || value.artifacts.length > MAX_ARTIFACTS) throw failure("WALLET_CLIENT_RESULT_INVALID");
  const artifacts = [];
  let total = 0;
  for (const artifact of value.artifacts) {
    if (!object(artifact) || Object.keys(artifact).sort().join(",") !== "mediaType,name" ||
        typeof artifact.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(artifact.name) ||
        basename(artifact.name) !== artifact.name || typeof artifact.mediaType !== "string" ||
        !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(artifact.mediaType)) throw failure("CLIENT_ARTIFACT_INVALID");
    const path = join(directory, artifact.name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0 || info.size > MAX_ARTIFACT_BYTES ||
        (total += info.size) > MAX_ARTIFACT_BYTES * 2 || await realpath(path) !== path) throw failure("CLIENT_ARTIFACT_INVALID");
    const file = await open(path, "r");
    try {
      const stat = await file.stat();
      if (stat.ino !== info.ino || stat.dev !== info.dev || stat.size !== info.size) throw failure("CLIENT_ARTIFACT_INVALID");
      const bytes = await file.readFile();
      if (bytes.length !== info.size) throw failure("CLIENT_ARTIFACT_INVALID");
      artifacts.push({ path, mediaType: artifact.mediaType, name: artifact.name, bytes: bytes.length, verifiedMediaType: verifiedImageType(bytes),
        sha256: createHash("sha256").update(bytes).digest("hex") });
      bytes.fill(0);
    } finally { await file.close(); }
  }
  return { kind: "client-result", status: value.status, diagnosticCode: value.diagnosticCode,
    operationId: value.operationId, paymentId: value.paymentId, artifacts, presentation: clientPresentation(value.presentation, args, sensitive) };
}

function clientEnvironment(): NodeJS.ProcessEnv {
  const names = new Set(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
    "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]);
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name.toUpperCase())));
}
