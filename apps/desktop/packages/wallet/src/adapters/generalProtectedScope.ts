import { randomUUID, createHash } from "node:crypto";
import type { ProtectedStore } from "../app/ports.js";
import type { ProtectedHostConnection } from "../protected-host.js";
import type { GeneralSessionInput, GeneralSessionResponse } from "./generalSessionChannel.js";
import type { GeneralAuthRequest } from "./generalNativeAuthScope.js";
import type { GeneralInitializationRecord } from "./generalInitializationRecord.js";
import { encodeGeneralAuthRequest } from "./generalNativeAuthScope.js";
import { canonical } from "./canonical.js";
import { requireWallet } from "../domain/errors.js";

type Kind = "inspection" | "operation" | "initialization";
type ResourceKind = Parameters<ProtectedHostConnection["materializeResource"]>[0];
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Private sealed Host actor. Native peer, guard and record backend remain the
 * actual authority. This owner only serializes their one original scope. */
export class GeneralProtectedScope implements ProtectedStore {
  private scope?: { id: string; kind: Kind };
  private busy = false;
  private closed = false;
  private readonly observed = new Map<string, string | null>();
  constructor(private readonly connection: ProtectedHostConnection,
    private readonly locale: "en-US" | "zh-CN", private readonly authenticationPhase: (pending: boolean) => void) {}
  assertCurrent(): void {
    requireWallet(!this.closed, "GENERAL_OPERATION_CANCELED", "The original native scope is closed."); this.connection.assertCurrent();
  }
  private async response(input: GeneralSessionInput, value?: Uint8Array, maximumMs = 30_000): Promise<GeneralSessionResponse> {
    this.assertCurrent();
    const response = await this.connection.request(input, performance.now() + maximumMs, value);
    try {
      this.assertCurrent();
      requireWallet(response.reply.status === "ok", response.reply.code, "The native protected command did not complete.");
      return response;
    } catch (error) { response.value.fill(0); throw error; }
  }
  private async begin(kind: Kind, auth?: Omit<GeneralAuthRequest, "format" | "version" | "requestId" | "locale">,
    record?: GeneralInitializationRecord, signal?: AbortSignal): Promise<void> {
    this.assertCurrent(); requireWallet(!this.busy, "GENERAL_OPERATION_BUSY", "The original native scope is busy.");
    this.busy = true;
    try {
      await this.end(); this.assertCurrent();
      requireWallet(!signal?.aborted, "GENERAL_OPERATION_CANCELED", "The native operation was canceled.");
      const requestId = randomUUID(), operationId = randomUUID();
      const request: GeneralSessionInput = { command: "begin", requestId, operationId, body: kind === "inspection" ? { kind } :
        kind === "initialization" && record ? { kind, initializationId: record.initializationId, initializationDigest: record.planDigest } : { kind: "operation", planId: null } };
      let bytes: Buffer | undefined;
      if (auth) {
        const scope: GeneralAuthRequest = { ...auth, format: "koincode-general-auth-request", version: 1, requestId, locale: this.locale };
        bytes = Buffer.from(record ? canonical({ authRequest: JSON.parse(encodeGeneralAuthRequest(scope)), record }) : encodeGeneralAuthRequest(scope));
      }
      let cancellation: Promise<GeneralSessionResponse> | undefined;
      let pending = true;
      const cancel = () => {
        if (!pending || cancellation) return;
        cancellation = this.connection.request({ command: "cancel", requestId: randomUUID(), operationId, body: { targetRequestId: requestId } }, performance.now() + 30_000);
        void cancellation.catch(() => {});
      };
      try {
        if (kind !== "inspection") this.authenticationPhase(true);
        const work = this.response(request, bytes, kind === "inspection" ? 30_000 : 360_000);
        signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
        const response = await work;
        response.value.fill(0); this.scope = { id: operationId, kind }; this.observed.clear();
      } finally {
        pending = false; signal?.removeEventListener("abort", cancel); bytes?.fill(0);
        try {
          if (cancellation) { const reply = await cancellation; try { requireWallet(reply.reply.status === "ok", "GENERAL_REGISTRATION_UNCERTAIN", "Native cancellation did not drain."); } finally { reply.value.fill(0); } }
        } finally { if (kind !== "inspection") this.authenticationPhase(false); }
      }
      requireWallet(!signal?.aborted, "GENERAL_OPERATION_CANCELED", "The native operation was canceled.");
    } finally { this.busy = false; }
  }
  inspection(): Promise<void> { return this.begin("inspection"); }
  authorize(auth: Omit<GeneralAuthRequest, "format" | "version" | "requestId" | "locale">, signal?: AbortSignal): Promise<void> {
    return this.begin("operation", auth, undefined, signal);
  }
  initialize(record: GeneralInitializationRecord, signal?: AbortSignal): Promise<void> {
    return this.begin("initialization", { action: "create_wallet", operationDigest: record.planDigest, accountAddress: null }, record, signal);
  }
  async end(): Promise<void> {
    this.assertCurrent(); if (!this.scope) return;
    const response = await this.response({ command: "end", requestId: randomUUID(), operationId: this.scope.id, body: {} });
    response.value.fill(0); this.scope = undefined; this.observed.clear();
  }
  private operation(): string { this.assertCurrent(); requireWallet(this.scope, "GENERAL_AUTH_REQUIRED", "A native scope is required."); return this.scope.id; }
  async get(reference: string): Promise<Uint8Array | null> {
    const response = await this.response({ command: "read", requestId: randomUUID(), operationId: this.operation(), body: { reference } });
    if (!("presence" in response.reply.body)) { response.value.fill(0); throw new Error("GENERAL_PROTECTION_UNAVAILABLE"); }
    if (response.reply.body.presence === "missing") { response.value.fill(0); this.observed.set(reference, null); return null; }
    this.observed.set(reference, hash(response.value)); return response.value;
  }
  async put(reference: string, value: Uint8Array): Promise<void> {
    const operationId = this.operation();
    requireWallet(this.scope!.kind !== "inspection", "GENERAL_AUTH_REQUIRED", "Inspection cannot write protected records.");
    const nextDigest = hash(value), response = await this.response({ command: "write", requestId: randomUUID(), operationId,
      body: { reference, expectedDigest: this.observed.get(reference) ?? null, nextDigest } }, value);
    response.value.fill(0); this.observed.set(reference, nextDigest);
  }
  async resources(record: GeneralInitializationRecord): Promise<void> {
    for (const kind of ["profiles_root", "profile_directory", "history_directory", "state_repository", "signing_repository"] as ResourceKind[]) {
      const operationId = this.operation();
      const prepared = await this.response({ command: "resource", requestId: randomUUID(), operationId, body: { action: "prepare", kind,
        profileId: kind === "profiles_root" ? null : record.initializationId, originKind: "initialization", originId: record.initializationId, originDigest: record.planDigest } });
      prepared.value.fill(0); const ticket = prepared.reply.body;
      requireWallet("ticketId" in ticket && "mode" in ticket, "GENERAL_PROTECTION_UNAVAILABLE", "The original resource ticket is unavailable.");
      requireWallet(this.scope!.kind !== "inspection" || ticket.mode === "open", "GENERAL_PROTECTION_UNAVAILABLE", "Inspection cannot create resources.");
      if (ticket.mode === "create") {
        const started = await this.response({ command: "resource", requestId: randomUUID(), operationId, body: { action: "start", ticketId: ticket.ticketId } }); started.value.fill(0);
      }
      this.connection.materializeResource(kind);
      const committed = await this.response({ command: "resource", requestId: randomUUID(), operationId, body: { action: "commit", ticketId: ticket.ticketId } }); committed.value.fill(0);
    }
  }
  /** Call only after the actual runtime/repositories have drained. */
  async close(): Promise<void> { if (this.closed) return; await this.end(); this.closed = true; this.observed.clear(); }
}
