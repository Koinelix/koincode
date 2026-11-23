import type { Duplex } from "node:stream";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { WalletRuntime } from "../app/runtime.js";
import type { WalletRequests } from "../app/requests.js";
import type { ClientHandle } from "../app/sessions.js";
import type { PeerIdentityProof } from "../app/peerIdentity.js";
import { ResponseExporter } from "./responseExport.js";
import { connectWalletMcp } from "./mcpServer.js";
import { requireWallet } from "../domain/errors.js";
import { createAuthenticatedPaymentClient } from "./paymentClient.js";
import { serveAuthenticatedPaymentProtocol } from "./paymentProtocol.js";
export type WalletSocketOptions = {
  presentPayment?: Parameters<typeof createAuthenticatedPaymentClient>[0]["present"];
  peerHelper?: string;
  approvePeerIdentity?: (clientId: string, handle: ClientHandle, proof: PeerIdentityProof) => Promise<boolean>;
  approveDestinations?: (clientId: string, handle: ClientHandle, exporter: ResponseExporter) => Promise<void>;
};
class SocketTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  #buffer = Buffer.alloc(0);
  constructor(private readonly socket: Duplex) {}
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

/** Both native transports enter the same authentication, approval and protocol path. */
export function attachWalletConnection(runtime: WalletRuntime, requests: WalletRequests, socket: Duplex,
  options: WalletSocketOptions, lifecycle: { sockets: Set<Duplex>; paymentStreams: Set<Promise<void>>; pending?: Set<Promise<void>> },
  inspect?: (handle: ClientHandle) => Promise<PeerIdentityProof>): void {
  const { sockets, paymentStreams } = lifecycle;
  const track = (work: Promise<void>) => {
    lifecycle.pending?.add(work);
    void work.finally(() => lifecycle.pending?.delete(work)).catch(() => socket.destroy());
  };
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
      if (handle) track((async () => {
        await paymentStream?.catch(() => {});
        await runtime.sessions.disconnect(handle);
      })().catch(() => {}));
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
      socket.off("data", onData);
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
        const proof = inspect ? await inspect(handle) : undefined;
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
    const onData = (chunk: Buffer) => track(authenticate(chunk));
    socket.on("data", onData);
    socket.on("close", () => clearTimeout(timeout));
}
