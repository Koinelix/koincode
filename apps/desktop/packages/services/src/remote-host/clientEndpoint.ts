import { createServer, type Server } from "node:net";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { REMOTE_HOST_LIMITS, REMOTE_HOST_PROTOCOL_VERSION, REMOTE_HOST_TOOLS, RemoteHostError,
  remoteHostFailure, remoteIdSchema, type RemoteHostToolName } from "@fcode/shared";
import type { RemoteClientPrincipal } from "./invocationRegistry.js";
import type { RemoteHostPrivateListener, RemoteHostPrivateListenerFactory } from "./privateListener.js";

const clientRequestSchema = z.strictObject({ protocolVersion: z.literal(2), id: remoteIdSchema,
  token: z.string().regex(/^[a-f0-9]{64}$/), method: z.enum(REMOTE_HOST_TOOLS), input: z.unknown(),
  identity: z.strictObject({ sessionId: remoteIdSchema, turnId: remoteIdSchema, toolCallId: remoteIdSchema }),
});
export type RemoteClientInvocation = z.infer<typeof clientRequestSchema>;

/** This endpoint exposes only the eight model methods; lifecycle and permission writers use parentPort. */
export class RemoteHostClientEndpoint {
  private readonly clients = new Map<string, RemoteClientPrincipal>();
  private readonly sockets = new Set<Duplex>();
  private readonly server: Server;
  private privateListener?: RemoteHostPrivateListener;
  private directory?: string;
  private path?: string;
  private starting?: Promise<void>;
  constructor(private readonly invoke: (principal: RemoteClientPrincipal, identity: RemoteClientInvocation["identity"],
    method: RemoteHostToolName, input: unknown, signal: AbortSignal) => Promise<unknown>, private readonly platform = process.platform,
    private readonly privateListenerFactory?: RemoteHostPrivateListenerFactory) {
    this.server = createServer((socket) => this.accept(socket));
  }

  start(): Promise<void> { return this.starting ??= this.startOnce().catch((error: unknown) => { this.starting = undefined; throw error; }); }

  private async startOnce(): Promise<void> {
    if (this.path) return;
    if (this.privateListenerFactory) {
      this.privateListener = await this.privateListenerFactory((socket) => this.accept(socket));
      this.path = this.privateListener.path; return;
    }
    if (this.platform === "win32") throw new RemoteHostError("remote_runtime_not_supported",
      "Windows Remote Host execution requires an accepted private named-pipe ACL backend.", "authorization");
    this.directory = await mkdtemp(join(tmpdir(), "frh-")); await chmod(this.directory, 0o700);
    this.path = join(this.directory, "broker.sock");
    try {
      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject); this.server.listen(this.path!, () => { this.server.off("error", reject); resolve(); });
      });
      await chmod(this.path, 0o600);
    } catch (error) { this.path = undefined; if (this.directory) await rm(this.directory, { recursive: true, force: true }); throw error; }
  }

  /** Only a trusted Main/Host registration path may issue a token for a verified Agent generation. */
  issue(principal: RemoteClientPrincipal): { socket: string; token: string; protocolVersion: number } {
    if (!this.path || this.clients.size >= 512) throw new RemoteHostError("storage_busy", "The broker client budget is unavailable.");
    const token = randomBytes(32).toString("hex"); this.clients.set(token, { ...principal });
    return { socket: this.path, token, protocolVersion: REMOTE_HOST_PROTOCOL_VERSION };
  }
  revokeClient(clientInstanceId: string): void {
    for (const [token, principal] of this.clients) if (principal.clientInstanceId === clientInstanceId) this.clients.delete(token);
  }
  async dispose(): Promise<void> {
    this.clients.clear(); for (const socket of this.sockets) socket.destroy();
    await this.privateListener?.close(); this.privateListener = undefined;
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.path = undefined;
  }

  private accept(socket: Duplex): void {
    if (this.sockets.size >= 64) { socket.destroy(); return; }
    this.sockets.add(socket);
    const controller = new AbortController();
    let buffer = Buffer.alloc(0);
    let handling = false;
    const timeout = setTimeout(() => socket.destroy(), REMOTE_HOST_LIMITS.commandMs); timeout.unref();
    socket.on("error", () => {});
    socket.once("close", () => { clearTimeout(timeout); controller.abort(); this.sockets.delete(socket); });
    socket.on("data", (bytes: Buffer) => {
      if (handling) { socket.destroy(); return; }
      if (buffer.length + bytes.length > REMOTE_HOST_LIMITS.ipcBytes) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, bytes]);
      const end = buffer.indexOf(10);
      if (end < 0) return;
      handling = true;
      if (end !== buffer.length - 1) { socket.destroy(); return; }
      let request: RemoteClientInvocation;
      try { request = clientRequestSchema.parse(JSON.parse(buffer.subarray(0, end).toString("utf8"))); }
      catch { socket.destroy(); return; }
      buffer = Buffer.alloc(0);
      const principal = this.clients.get(request.token);
      if (!principal) {
        socket.end(JSON.stringify({ id: request.id, ok: false, error: new RemoteHostError("permission_denied", "The broker client credential is invalid.", "authorization").toJSON() }) + "\n"); return;
      }
      void this.invoke(principal, request.identity, request.method, request.input, controller.signal).then(
        (value) => {
          const response = JSON.stringify({ id: request.id, ok: true, value });
          if (Buffer.byteLength(response) > REMOTE_HOST_LIMITS.ipcBytes) throw new RemoteHostError("output_limit", "The broker response exceeds its transport budget.");
          socket.end(response + "\n");
        },
      ).catch((error: unknown) => { if (!socket.destroyed) socket.end(JSON.stringify({ id: request.id, ok: false, error: remoteHostFailure(error) }) + "\n"); });
    });
  }
}
