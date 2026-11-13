import { randomUUID } from "node:crypto";
import { RemoteHostRuntime, RemoteHostControlRouter, acquireRemoteBrokerLease, createWindowsRemoteHostListener,
  prepareWindowsRemoteHostStorage, disposeWindowsRemoteHostStorage, type RemoteSystemSecretPort } from "@fcode/services/remote-host/node";
import { RemoteSshTransport } from "@fcode/server/remote-host";
import { REMOTE_HOST_LIMITS, RemoteHostError, remoteHostFailure, remoteBrokerRequestSchema,
  remoteBrokerReplySchema, remoteSecretEnvelopeSchema, type RemoteBrokerSecretRequest } from "@fcode/shared";

const { parentPort } = process;
if (!parentPort) throw new Error("Remote Host broker requires a private parent port.");
const pendingSecrets = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
let runtime: RemoteHostRuntime | undefined;
let control: RemoteHostControlRouter | undefined;
let initialization: Promise<RemoteHostRuntime> | undefined;
let releaseLease: (() => Promise<void>) | undefined;
let stopped = false;

function secretRequest(operation: RemoteBrokerSecretRequest["operation"], payload: unknown): Promise<unknown> {
  if (stopped) return Promise.reject(new RemoteHostError("credential_locked", "The broker is stopping.", "storage"));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pendingSecrets.delete(id); reject(new RemoteHostError("credential_locked", "System-protected storage did not respond.", "storage")); }, 30_000);
    timer.unref(); pendingSecrets.set(id, { resolve, reject, timer });
    parentPort!.postMessage({ kind: "secret_request", id, operation, payload } satisfies RemoteBrokerSecretRequest);
  });
}
const systemSecrets: RemoteSystemSecretPort = {
  async getStatus() {
    const value = await secretRequest("status", null);
    if (typeof value !== "object" || value === null || !("available" in value) || typeof value.available !== "boolean" ||
      !("backend" in value) || typeof value.backend !== "string") throw new RemoteHostError("secure_store_unavailable", "The system protection status is invalid.", "storage");
    return { available: value.available, backend: value.backend };
  },
  async seal(envelope) {
    const value = await secretRequest("seal", remoteSecretEnvelopeSchema.parse(envelope));
    if (typeof value !== "string" || !value) throw new RemoteHostError("secure_store_unavailable", "System protection did not return a valid credential.", "storage");
    return value;
  },
  async open(ciphertext) { return remoteSecretEnvelopeSchema.parse(await secretRequest("open", ciphertext)); },
};

async function initialize(root: string): Promise<RemoteHostRuntime> {
  try {
    if (process.platform === "win32") await prepareWindowsRemoteHostStorage(root);
    releaseLease = await acquireRemoteBrokerLease(root);
    runtime = await RemoteHostRuntime.create({ root, systemSecrets, transport: new RemoteSshTransport(),
      workspaceRoot: (context) => control?.workspaceRoot(context),
      assertPluginAvailable: (context) => {
        if (!control) throw new RemoteHostError("plugin_unavailable", "The trusted Remote Host plugin is not registered for this Agent.", "authorization");
        control.assertAvailable(context);
      } });
    control = new RemoteHostControlRouter(runtime, process.platform === "win32" ? createWindowsRemoteHostListener : undefined);
    return runtime;
  } catch (error) {
    try { await runtime?.dispose(); }
    finally {
      try { await releaseLease?.(); releaseLease = undefined; }
      finally { if (process.platform === "win32") await disposeWindowsRemoteHostStorage(); }
    }
    throw error;
  }
}

async function shutdown(): Promise<void> {
  if (stopped) return;
  stopped = true;
  for (const request of pendingSecrets.values()) { clearTimeout(request.timer); request.reject(new RemoteHostError("credential_locked", "The broker stopped.", "storage")); }
  pendingSecrets.clear();
  try { try { await control?.dispose(); } finally { await runtime?.dispose(); } }
  finally {
    try { await releaseLease?.(); }
    finally { if (process.platform === "win32") await disposeWindowsRemoteHostStorage(); }
  }
}

parentPort.on("message", (event: Electron.MessageEvent) => {
  const raw: unknown = event.data;
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > REMOTE_HOST_LIMITS.ipcBytes) return;
  } catch { return; }
  const reply = remoteBrokerReplySchema.safeParse(raw);
  if (reply.success) {
    const pending = pendingSecrets.get(reply.data.id);
    if (!pending) return;
    clearTimeout(pending.timer); pendingSecrets.delete(reply.data.id);
    if (reply.data.ok) pending.resolve(reply.data.value); else pending.reject(new RemoteHostError(reply.data.error.code, reply.data.error.message, reply.data.error.stage));
    return;
  }
  const parsed = remoteBrokerRequestSchema.safeParse(raw);
  if (!parsed.success) return;
  const request = parsed.data;
  void (async () => {
    if (stopped) throw new RemoteHostError("canceled", "The Remote Host broker has stopped.");
    if (request.kind === "initialize") {
      if (initialization) throw new RemoteHostError("permission_denied", "The broker was already initialized.");
      initialization = initialize(request.root); const ready = await initialization;
      return { ownerId: ready.database.ownerId, brokerGeneration: ready.registry.generation };
    }
    if (request.kind === "dispose") { await shutdown(); return { disposed: true }; }
    const ready = await initialization;
    if (!ready) throw new RemoteHostError("permission_denied", "The broker has not been initialized.");
    if (request.kind === "control") return control!.control(request.scope, request.command);
    if (request.kind === "revoke-host") { control!.revokeHost(request.hostId); return { revoked: true }; }
    if (request.kind === "revoke-management-client") { ready.managementOperations.cancelClient(request.clientInstanceId); return { revoked: true }; }
    return ready.manage(request.method, request.input, request.clientInstanceId, request.selectedPath, request.windowId);
  })().then((value) => parentPort!.postMessage({ kind: "reply", id: request.id, ok: true, value }),
    (error: unknown) => parentPort!.postMessage({ kind: "reply", id: request.id, ok: false, error: remoteHostFailure(error) }));
});
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
