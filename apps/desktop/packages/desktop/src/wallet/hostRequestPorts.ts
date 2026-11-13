import * as wallet from "@koincode/wallet/node";
import { randomUUID } from "node:crypto";

type Connections = Pick<wallet.HostWalletConnections, "connect" | "close"> & Partial<Pick<wallet.HostWalletConnections, "prepareDesktopClient">>;
type Port = Electron.MessagePortMain;
const MAX_PORTS = 32;

function closePort(port: Port): void {
  try {
    port.close();
  } catch {
    /* Rejected endpoints never become capabilities. */
  }
}
function cleanup(action: () => unknown): Promise<unknown> {
  try {
    return Promise.resolve(action());
  } catch (error) {
    return Promise.reject(error);
  }
}

/** The utility owns transferred endpoints until their sessions and SDK work have drained. */
export class WalletHostRequestPorts {
  private readonly bindings = new Set<{ close(): Promise<void> }>();
  private readonly opening = new Set<Promise<void>>();
  private readonly connectionsById = new Map<string, { close(): Promise<void>; decidePayment: wallet.HostWalletConnection["decidePayment"]; approveDestination?: wallet.HostWalletConnection["approveDestination"] }>();
  private readonly pendingById = new Map<string, { done: Promise<void>; cancel(): void }>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly connections: Connections) {}
  async prepareDesktopClient(): Promise<{ clientId: string; mode: "open" }> {
    if (this.closed || !this.connections.prepareDesktopClient) throw new Error("WALLET_CHANNEL_CLOSED");
    return this.connections.prepareDesktopClient();
  }

  bind(
    port: Port,
    clientId: string,
    chatId: string,
    mode: "create" | "open",
    connectionId: string = randomUUID(),
    presentPayment?: wallet.HostPaymentPresenter,
    hostGrantScope?: string,
  ): Promise<void> {
    if (
      this.closed ||
      !/^[0-9a-f-]{36}$/.test(connectionId) ||
      this.connectionsById.has(connectionId) ||
      this.pendingById.has(connectionId) ||
      this.bindings.size + this.opening.size >= MAX_PORTS
    ) {
      closePort(port);
      return Promise.reject(new Error("WALLET_CHANNEL_CAPACITY"));
    }
    let ended = false;
    const onEarlyClose = () => {
      ended = true;
    };
    const onEarlyMessage = () => {
      ended = true;
      closePort(port);
    };
    port.once("close", onEarlyClose);
    port.on("message", onEarlyMessage);
    // Register before connecting: stop and remote close may race authentication.
    const pending = Promise.resolve()
      .then(async () => {
        if (this.closed || ended) throw new Error("WALLET_CHANNEL_CLOSED");
        const connection = await this.connections.connect(clientId, chatId, mode, presentPayment, hostGrantScope);
        let server: ReturnType<typeof wallet.serveHostWalletRequests> | undefined;
        let closing: Promise<void> | undefined;
        const binding = {
          approveDestination: connection.approveDestination?.bind(connection),
          decidePayment: connection.decidePayment?.bind(connection),
          close: (): Promise<void> => {
            if (closing) return closing;
            ended = true;
            let finish!: () => void, fail!: (error: unknown) => void;
            closing = new Promise<void>((resolve, reject) => {
              finish = resolve;
              fail = reject;
            });
            port.off("close", onEarlyClose);
            port.off("message", onEarlyMessage);
            port.off("close", onClose);
            const serverDrain = cleanup(() => server?.close());
            const sessionDrain = cleanup(() => connection.close());
            closePort(port);
            void Promise.allSettled([serverDrain, sessionDrain])
              .then((results) => {
                for (const result of results) if (result.status === "rejected") throw result.reason;
                this.bindings.delete(binding);
                if (this.connectionsById.get(connectionId) === binding)
                  this.connectionsById.delete(connectionId);
              })
              .then(finish, fail);
            return closing;
          },
        };
        const onClose = () => {
          void binding.close().catch(() => {});
        };
        this.bindings.add(binding);
        this.connectionsById.set(connectionId, binding);
        try {
          if (this.closed || ended) throw new Error("WALLET_CHANNEL_CLOSED");
          port.on("close", onClose);
          // There is no asynchronous gap between removing the early-message fence
          // and subscribing the authenticated request handler.
          port.off("message", onEarlyMessage);
          server = wallet.serveHostWalletRequests(
            {
              send: (message) => port.postMessage(message),
              close: () => {
                // Protocol closure must invalidate the SDK session as well as the endpoint.
                ended = true;
                closePort(port);
                queueMicrotask(onClose);
              },
              subscribe(message, closed) {
                const receive = (event: Electron.MessageEvent) => message(event.data);
                port.on("message", receive);
                port.on("close", closed);
                port.start();
                return () => {
                  port.off("message", receive);
                  port.off("close", closed);
                };
              },
            },
            connection,
          );
          if (this.closed || ended) throw new Error("WALLET_CHANNEL_CLOSED");
          port.off("close", onEarlyClose);
        } catch (error) {
          await binding.close();
          throw error;
        }
      })
      .catch((error) => {
        port.off("close", onEarlyClose);
        port.off("message", onEarlyMessage);
        closePort(port);
        throw error;
      });
    this.opening.add(pending);
    const opening = {
      done: pending,
      cancel: () => {
        ended = true;
        closePort(port);
      },
    };
    this.pendingById.set(connectionId, opening);
    // A pending connection must observe real Electron close events immediately.
    // Any data sent before its acknowledgement is a protocol violation.
    try {
      port.start();
    } catch {
      ended = true;
      closePort(port);
    }
    void pending
      .finally(() => {
        this.opening.delete(pending);
        if (this.pendingById.get(connectionId) === opening) this.pendingById.delete(connectionId);
      })
      .catch(() => {});
    return pending;
  }

  async disconnect(connectionId: string): Promise<void> {
    const pending = this.pendingById.get(connectionId);
    if (pending) {
      pending.cancel();
      await pending.done.catch(() => {});
    }
    await this.connectionsById.get(connectionId)?.close();
  }

  async approveDestination(connectionId: string, requestId: string, directory: string, name: string): Promise<string> {
    const binding = this.connectionsById.get(connectionId);
    if (this.closed || !binding?.approveDestination) throw new Error("DESTINATION_NOT_FOUND");
    return binding.approveDestination(requestId, directory, name);
  }

  async decidePayment(connectionId: string, approvalId: string, choice: wallet.PaymentApprovalChoice, signal: AbortSignal): Promise<unknown> {
    const binding = this.connectionsById.get(connectionId);
    if (this.closed || !binding?.decidePayment) throw new Error("PAYMENT_APPROVAL_UNAVAILABLE");
    return binding.decidePayment(approvalId, choice, signal);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const pending of this.pendingById.values()) pending.cancel();
    let finish!: () => void, fail!: (error: unknown) => void;
    this.closing = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    // Invalidate the SDK owner synchronously, before awaiting opening endpoints.
    const ownerDrain = cleanup(() => this.connections.close());
    const drains = [...this.bindings].map((binding) => binding.close());
    void (async () => {
      const results = await Promise.allSettled([ownerDrain, ...drains]);
      await Promise.allSettled(this.opening);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    })().then(finish, fail);
    return this.closing;
  }
}
