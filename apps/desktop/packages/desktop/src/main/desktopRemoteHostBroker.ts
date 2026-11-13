import { utilityProcess, type UtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { REMOTE_HOST_LIMITS, REMOTE_HOST_PROTOCOL_VERSION, RemoteHostError, remoteHostFailure,
  remoteBrokerReplySchema, remoteBrokerSecretRequestSchema, type RemoteBrokerRequest } from "@fcode/shared";
import { handleRemoteHostSecretRequest } from "./desktopRemoteHostSecrets.js";
import { buildHostProcessEnv } from "./desktopRuntimeEnv.js";

type RequestBody = RemoteBrokerRequest extends infer R ? R extends { id: string } ? Omit<R, "id"> : never : never;
interface PendingRequest { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }

/** Lazy and unique per Main instance; the child also acquires a data-root OS lock. */
export class DesktopRemoteHostBroker {
  private child?: UtilityProcess;
  private initialization?: Promise<void>;
  private readonly pending = new Map<string, PendingRequest>();
  private disposed = false;
  constructor(private readonly root: () => string, private readonly localEnv: () => Record<string, string>) {}

  async request(body: Exclude<RequestBody, { kind: "initialize" | "dispose" }>): Promise<unknown> {
    await this.ensureStarted(); return this.send(body);
  }

  revokeHost(hostId: string): void {
    if (this.child) void this.request({ kind: "revoke-host", hostId }).catch(() => {});
  }

  revokeManagementClient(clientInstanceId: string): void {
    if (this.child) void this.request({ kind: "revoke-management-client", clientInstanceId }).catch(() => {});
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const child = this.child;
    if (!child) return;
    const force = setTimeout(() => child.kill(), REMOTE_HOST_LIMITS.cancelWaitMs + 1500);
    try { await this.send({ kind: "dispose" }); }
    catch { /* Incomplete remote operations remain uncertain and are recovered on the next explicit use. */ }
    finally { clearTimeout(force); child.kill(); this.child = undefined; this.failPending(); }
  }

  private ensureStarted(): Promise<void> {
    if (this.disposed) return Promise.reject(new RemoteHostError("canceled", "The Remote Host broker is stopping."));
    if (this.initialization) return this.initialization;
    const child = utilityProcess.fork(fileURLToPath(new URL("../remote-host/index.js", import.meta.url)), [], {
      serviceName: "fcode-remote-host-broker", execArgv: ["--no-warnings"],
      env: { ...buildHostProcessEnv(this.localEnv()), FCODE_PROCESS_LABEL: "remote-host-broker" },
    });
    this.child = child;
    child.on("message", (raw: unknown) => {
      try { if (Buffer.byteLength(JSON.stringify(raw)) > REMOTE_HOST_LIMITS.ipcBytes) return; } catch { return; }
      const secret = remoteBrokerSecretRequestSchema.safeParse(raw);
      if (secret.success) {
        try { child.postMessage({ kind: "reply", id: secret.data.id, ok: true, value: handleRemoteHostSecretRequest(secret.data) }); }
        catch (error) { child.postMessage({ kind: "reply", id: secret.data.id, ok: false, error: remoteHostFailure(error) }); }
        return;
      }
      const reply = remoteBrokerReplySchema.safeParse(raw);
      if (!reply.success) return;
      const pending = this.pending.get(reply.data.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(reply.data.id);
      if (reply.data.ok) pending.resolve(reply.data.value);
      else pending.reject(new RemoteHostError(reply.data.error.code, reply.data.error.message, reply.data.error.stage));
    });
    child.once("exit", () => {
      if (this.child !== child) return;
      this.child = undefined; this.initialization = undefined; this.failPending();
    });
    this.initialization = this.send({ kind: "initialize", root: this.root(), protocolVersion: REMOTE_HOST_PROTOCOL_VERSION }).then(() => {});
    return this.initialization;
  }

  private send(body: RequestBody): Promise<unknown> {
    if (!this.child) return Promise.reject(new RemoteHostError("connection_failed", "The Remote Host broker is unavailable.", "connection"));
    if (Buffer.byteLength(JSON.stringify(body)) > REMOTE_HOST_LIMITS.ipcBytes || this.pending.size >= 512) {
      return Promise.reject(new RemoteHostError("transfer_limit", "The broker request exceeds its transport budget."));
    }
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RemoteHostError("connection_timeout", "The Remote Host broker request timed out.", "connection")); }, REMOTE_HOST_LIMITS.maxExecutionMs);
      timer.unref(); this.pending.set(id, { resolve, reject, timer });
      try { this.child!.postMessage({ ...body, id }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new RemoteHostError("connection_failed", "The broker request could not be delivered.", "connection")); }
    });
  }
  private failPending(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new RemoteHostError("connection_failed", "The Remote Host broker exited.", "connection")); }
    this.pending.clear();
  }
}
