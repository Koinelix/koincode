import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getCapturedRemoteHostBrokerCredentials, RemoteHostError, REMOTE_HOST_LIMITS, REMOTE_HOST_PROTOCOL_VERSION,
  remoteHostControlResultSchema, remoteInvocationIdentitySchema, type RemoteHostToolName } from "@fcode/shared";

export async function invokeRemoteHost(method: RemoteHostToolName, input: unknown, identity: z.infer<typeof remoteInvocationIdentitySchema>,
  signal?: AbortSignal): Promise<unknown> {
  const credentials = getCapturedRemoteHostBrokerCredentials();
  if (!credentials) throw new RemoteHostError("plugin_unavailable", "Remote Host requires a local desktop broker.");
  remoteInvocationIdentitySchema.parse(identity); signal?.throwIfAborted();
  const id = randomUUID();
  const message = JSON.stringify({ protocolVersion: REMOTE_HOST_PROTOCOL_VERSION, id, token: credentials.token, method, input, identity }) + "\n";
  if (Buffer.byteLength(message) > REMOTE_HOST_LIMITS.ipcBytes) throw new RemoteHostError("transfer_limit", "The remote request exceeds its transport budget.");
  return new Promise((resolve, reject) => {
    const socket = connect(credentials.socket); let bytes = Buffer.alloc(0); let settled = false;
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) return; settled = true; signal?.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(signal?.reason ?? new RemoteHostError("canceled", "The remote request was canceled."));
    signal?.addEventListener("abort", abort, { once: true });
    socket.setTimeout(REMOTE_HOST_LIMITS.commandMs, () => finish(new RemoteHostError("connection_timeout", "The remote broker request timed out.")));
    socket.once("connect", () => { if (signal?.aborted) abort(); else socket.write(message); });
    socket.once("error", () => finish(new RemoteHostError("connection_failed", "The remote broker is unavailable.")));
    socket.once("close", () => { if (!settled) finish(new RemoteHostError("connection_failed", "The remote broker closed before replying.")); });
    socket.on("data", (chunk: Buffer) => {
      if (bytes.length + chunk.length > REMOTE_HOST_LIMITS.ipcBytes) { finish(new RemoteHostError("output_limit", "The broker response exceeds its budget.")); return; }
      bytes = Buffer.concat([bytes, chunk]); const end = bytes.indexOf(10); if (end < 0) return;
      try {
        const parsed = z.object({ id: z.literal(id), ok: z.boolean(), value: z.unknown().optional(), error: z.unknown().optional() }).strict().parse(JSON.parse(bytes.subarray(0, end).toString()));
        const result = remoteHostControlResultSchema.parse(parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: parsed.error });
        if (result.ok) finish(undefined, result.value); else finish(new RemoteHostError(result.error.code, result.error.message, result.error.stage));
      } catch (error) { finish(error); }
    });
  });
}
