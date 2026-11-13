import { inspectMacPeer } from "./peerIdentity.js";
import type { PeerIdentityProof } from "../app/peerIdentity.js";
import { createConnection, createServer, type Socket, type Server as NetServer } from "node:net";
import { lstat, realpath, chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { WalletRuntime } from "../app/runtime.js";
import type { WalletRequests } from "../app/requests.js";
import { ResponseExporter } from "./responseExport.js";
import type { ClientHandle } from "../app/sessions.js";
import { connectWalletMcp } from "./mcpServer.js";
import { requireWallet, WalletError } from "../domain/errors.js";
import { createAuthenticatedPaymentClient } from "./paymentClient.js";
import { serveAuthenticatedPaymentProtocol } from "./paymentProtocol.js";
class SocketTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  #buffer = Buffer.alloc(0);
  constructor(private readonly socket: Socket) {}
  async start(): Promise<void> {
    this.socket.on("data", (chunk) => {
      try {
        this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
        requireWallet(
          this.#buffer.length <= 2 * 1024 * 1024,
          "MCP_FRAME_TOO_LARGE",
          "The MCP frame exceeds its limit.",
        );
        for (let end; (end = this.#buffer.indexOf(10)) >= 0; ) {
          const raw = this.#buffer.subarray(0, end);
          this.#buffer = this.#buffer.subarray(end + 1);
          this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(raw.toString("utf8"))));
        }
      } catch {
        this.onerror?.(new Error("Invalid or oversized MCP frame."));
        this.socket.destroy();
      }
    });
    this.socket.on("error", () => this.onerror?.(new Error("The local MCP connection failed.")));
    this.socket.on("close", () => this.onclose?.());
    this.socket.resume();
  }
  async send(message: JSONRPCMessage): Promise<void> {
    const encoded = JSON.stringify(message) + "\n";
    requireWallet(
      !this.socket.destroyed &&
        this.socket.writableLength + Buffer.byteLength(encoded) <= 2 * 1024 * 1024,
      "MCP_BUSY",
      "The local MCP output queue is full.",
    );
    await new Promise<void>((resolve, reject) =>
      this.socket.write(encoded, (error) =>
        error ? reject(new Error("The local MCP write failed.")) : resolve(),
      ),
    );
  }
  async close(): Promise<void> {
    this.socket.destroy();
  }
}
export async function startWalletSocket(
  runtime: WalletRuntime,
  requests: WalletRequests,
  directory: string,
  options: {
    presentPayment?: Parameters<typeof createAuthenticatedPaymentClient>[0]["present"];
    peerHelper?: string;
    approvePeerIdentity?: (
      clientId: string,
      handle: ClientHandle,
      proof: PeerIdentityProof,
    ) => Promise<boolean>;
    approveDestinations?: (
      clientId: string,
      handle: ClientHandle,
      exporter: ResponseExporter,
    ) => Promise<void>;
  } = {},
): Promise<{ path: string; close: () => Promise<void> }> {
  requireWallet(
    process.platform !== "win32",
    "LOCAL_TRANSPORT_UNAVAILABLE",
    "This native socket adapter requires Unix; Windows must provide an ACL-authenticated pipe adapter.",
  );
  const info = await lstat(directory);
  requireWallet(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      (info.mode & 0o077) === 0 &&
      info.uid === process.getuid?.() &&
      (await realpath(directory)) === directory,
    "UNSAFE_STORAGE_PATH",
    "A private canonical socket directory is required.",
  );
  const path = join(directory, "wallet-mcp.sock");
  requireWallet(
    Buffer.byteLength(path) <= 100,
    "UNSAFE_STORAGE_PATH",
    "The local socket path exceeds its native limit.",
  );
  const sockets = new Set<Socket>();
  await removeStaleSocket(path);
  const paymentStreams = new Set<Promise<void>>();
  const server: NetServer = createServer((socket) => {
    if (sockets.size >= 32) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const timeout = setTimeout(() => socket.destroy(), 5000);
    let authenticated: ClientHandle | undefined;
    let paymentStream: Promise<void> | undefined;
    socket.once("close", () => {
      const handle = authenticated;
      if (handle) void (async () => {
        await paymentStream?.catch(() => {});
        await runtime.sessions.disconnect(handle);
      })().catch(() => {});
    });
    let buffer = Buffer.alloc(0),
      pending = false;
    const authenticate = async (chunk: Buffer) => {
      if (pending) {
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf(10);
      if (end < 0) return;
      pending = true;
      socket.pause();
      socket.off("data", authenticate);
      try {
        requireWallet(
          end === buffer.length - 1,
          "CLIENT_AUTHENTICATION_REQUIRED",
          "Handshake and protocol frames must be separate.",
        );
        const value = JSON.parse(buffer.subarray(0, end).toString("utf8"));
        requireWallet(
          value &&
            typeof value.clientId === "string" &&
            typeof value.token === "string" &&
            (Object.keys(value).sort().join() === "clientId,token" ||
              (Object.keys(value).sort().join() === "clientId,protocol,token" && value.protocol === "payment-v1")),
          "CLIENT_AUTHENTICATION_REQUIRED",
          "A registered client credential is required.",
        );
        const handle = await requests.connections.authenticate(value.clientId, value.token);
        authenticated = handle;
        if (socket.destroyed) {
          await runtime.sessions.disconnect(handle);
          authenticated = undefined;
          return;
        }
        const proof = options.peerHelper
          ? await inspectMacPeer(options.peerHelper, socket, handle)
          : undefined;
        requests.connections.checkPeer(handle, proof);
        if (proof && (await options.approvePeerIdentity?.(value.clientId, handle, proof)))
          await requests.connections.bindPeerIdentity(handle, proof);
        runtime.sessions.resolve(handle);
        buffer.fill(0);
        clearTimeout(timeout);
        const exporter = new ResponseExporter(requests);
        await options.approveDestinations?.(value.clientId, handle, exporter);
        if (socket.destroyed) {
          await runtime.sessions.disconnect(handle);
          authenticated = undefined;
          return;
        }
        requests.connections.checkPeer(handle, proof);
        runtime.sessions.resolve(handle);
        socket.write('{"authenticated":true}\n');
        if (value.protocol === "payment-v1") {
          const work = serveAuthenticatedPaymentProtocol(socket, createAuthenticatedPaymentClient({
            runtime, requests, handle, present: options.presentPayment,
          }));
          paymentStream = work;
          paymentStreams.add(work);
          void work.finally(() => paymentStreams.delete(work)).catch(() => socket.destroy());
        } else await connectWalletMcp(runtime, requests, handle, new SocketTransport(socket), exporter);
      } catch {
        if (authenticated) {
          await runtime.sessions.disconnect(authenticated).catch(() => {});
          authenticated = undefined;
        }
        buffer.fill(0);
        socket.destroy();
      }
    };
    socket.on("error", () => {});
    socket.on("data", authenticate);
    socket.on("close", () => clearTimeout(timeout));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", () =>
      reject(
        new WalletError(
          "LOCAL_TRANSPORT_UNAVAILABLE",
          "The private wallet socket could not be opened.",
        ),
      ),
    );
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  return {
    path,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled(paymentStreams);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(path).catch(() => {});
    },
  };
}

async function removeStaleSocket(path: string): Promise<void> {
  let prior;
  try { prior = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  requireWallet(prior.isSocket() && !prior.isSymbolicLink() && prior.uid === process.getuid?.() &&
    (prior.mode & 0o077) === 0, "UNSAFE_STORAGE_PATH", "An existing endpoint is not a private wallet socket.");
  const refused = await new Promise<boolean>(resolve => {
    const probe = createConnection(path);
    const timer = setTimeout(() => { probe.destroy(); resolve(false); }, 500);
    probe.once("connect", () => { clearTimeout(timer); probe.destroy(); resolve(false); });
    probe.once("error", error => { clearTimeout(timer); resolve((error as NodeJS.ErrnoException).code === "ECONNREFUSED"); });
  });
  requireWallet(refused, "LOCAL_TRANSPORT_UNAVAILABLE", "An existing wallet endpoint is live or cannot be verified.");
  const latest = await lstat(path);
  requireWallet(latest.ino === prior.ino && latest.dev === prior.dev && latest.isSocket() &&
    !latest.isSymbolicLink(), "UNSAFE_STORAGE_PATH", "The wallet endpoint changed during stale-socket verification.");
  await unlink(path);
}
