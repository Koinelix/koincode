import { DesktopWalletModelPayments, isFinalModelPaymentError } from "./desktopWalletModelPayments.js";
import { closeWalletConnection } from "./desktopWalletCloseConnection.js";
import { createHash, randomUUID } from "node:crypto";
import { createHostWalletChannelClient } from "@koincode/wallet/host";
import {
  walletHostMainCommandSchema, WALLET_HOST_MAX_BYTES, walletHostHasCapacity, WALLET_HOST_TIMEOUT_MS,
  type WalletHostAgent, type WalletHostMainCommand, type WalletHostMainResult,
} from "@fcode/shared";
import type { DesktopWalletProcess } from "./desktopWalletProcess.js";
import { attachWalletResponseDestination } from "./desktopWalletResponseExport.js";
import type { WalletResponseDestination } from "./desktopWalletResponseDestination.js";
import { assertWalletCurrent, codeOf, failure, sameAgent } from "./desktopWalletHostIdentity.js";
import { lookupWalletActivity } from "./desktopWalletActivityLookup.js";
import { DesktopWalletClientInvocations } from "./desktopWalletClientInvocations.js";
import type { Binding, Connection, Job, WalletHostScope, DesktopServiceRequestHandler } from "./desktopWalletHostTypes.js";
export type { WalletHostScope, DesktopServiceRequestContext, DesktopServiceRequestHandler } from "./desktopWalletHostTypes.js";
const MAX_AGENTS = 128;
const MAX_CONNECTIONS = 32;

/** Main owns channel lifetimes. Wallet policy, credentials, budgets and task permissions remain in their authoritative owners. */
export class DesktopWalletHostRequests {
  private binding?: Binding;
  private connecting?: Promise<void>;
  private epoch = 0;
  private closed = false;
  private exhausted = false;
  private readonly agents = new Map<string, WalletHostAgent & { ended: boolean; hostId: string; ready?: Promise<void> }>();
  private readonly connections = new Map<string, Connection>();
  private readonly jobs = new Map<string, Job>();
  private readonly clientInvocations = new DesktopWalletClientInvocations();
  private readonly modelPayments = new DesktopWalletModelPayments();
  private clientRequest?: DesktopServiceRequestHandler;
  constructor(
    private readonly wallet: Pick<DesktopWalletProcess, "connectHost" | "disconnectHost"> & Partial<Pick<DesktopWalletProcess, "approveHostDestination" | "stop">>,
    private readonly currentHost: (scope: WalletHostScope) => boolean,
    private readonly chooseDestination?: (requestId: string, signal: AbortSignal) => Promise<WalletResponseDestination | undefined>,
    private readonly connectDesktop?: () => Promise<{ clientId: string; mode: "open" }>,
  ) {}

  setClientRequestHandler(handler: DesktopServiceRequestHandler): void {
    if (this.clientRequest || this.closed) throw failure("WALLET_CLIENT_UNAVAILABLE");
    this.clientRequest = handler;
  }

  selectedClientId(): string | undefined { return this.binding?.clientId; }

  /** Main-only lookup. The caller must independently authenticate the requested chat route. */
  async lookupActivity(scope: WalletHostScope, workspaceKey: string, sessionId: string, paymentId: string, refresh = false): Promise<unknown> {
    const key = JSON.stringify([scope.hostId, workspaceKey]); return lookupWalletActivity(scope, workspaceKey, sessionId, paymentId, {
      currentHost: value => !this.closed && this.currentHost(value), currentAgent: () => this.agents.get(key),
      connect: async (agent, signal) => {
        await this.ensureDesktopConnection(); const binding = this.binding, epoch = this.epoch;
        if (!binding) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
        this.assertCurrent(scope, binding, epoch, signal);
        const connection = await this.connection(scope, binding, agent, sessionId, epoch, signal), client = await connection.ready;
        return { client, isCurrent: () => {
          try { this.assertCurrent(scope, binding, epoch, signal); return !connection.closed; } catch { return false; }
        } };
      },
    }, refresh);
  }
  ensureDesktopConnection(): Promise<void> {
    if (this.closed) return Promise.reject(failure("CLIENT_AUTHENTICATION_REQUIRED"));
    if (this.connecting) return this.connecting;
    const binding = this.binding;
    if (binding) {
      if (!binding.failed || !binding.automatic || binding.mode !== "open") return Promise.resolve();
      const epoch = ++this.epoch;
      const pending = Promise.all([...this.connections.values()].map((connection) => this.closeConnection(connection))).then(() => {
          if (this.closed || this.epoch !== epoch || this.binding !== binding)
            throw failure("CLIENT_AUTHENTICATION_REQUIRED");
          binding.initialized = undefined;
          binding.failed = false;
        }).finally(() => { if (this.connecting === pending) this.connecting = undefined; });
      this.connecting = pending;
      return pending;
    }
    if (!this.connectDesktop) return Promise.reject(failure("WALLET_CLIENT_NOT_CONFIGURED"));
    const epoch = this.epoch;
    const pending = this.connectDesktop().then(async (selection) => {
      if (this.closed || this.epoch !== epoch) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
      await this.selectClient(selection.clientId, selection.mode, undefined, true);
    }).finally(() => { if (this.connecting === pending) this.connecting = undefined; });
    this.connecting = pending;
    return pending;
  }

  /** Called only with a protected registration result or reauthenticated control-plane selection. */
  async selectClient(
    clientId: string,
    mode: "create" | "open",
    assertCurrent: () => void = () => {},
    automatic = false,
  ): Promise<void> {
    assertCurrent();
    if (this.closed || !/^[0-9a-f-]{36}$/.test(clientId) || !["create", "open"].includes(mode))
      throw failure("CLIENT_AUTHENTICATION_REQUIRED");
    if (this.binding?.clientId === clientId && !this.binding.failed) return;
    if (automatic && (this.binding || this.connections.size || mode !== "open"))
      throw failure("CLIENT_AUTHENTICATION_REQUIRED");
    const epoch = ++this.epoch;
    this.binding = undefined;
    if (!automatic) for (const job of this.jobs.values()) job.controller.abort();
    await Promise.all(
      [...this.connections.values()].map((connection) => this.closeConnection(connection)),
    );
    assertCurrent();
    if (this.closed || epoch !== this.epoch) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
    this.binding = { clientId, mode, automatic };
  }

  async handle(scope: WalletHostScope, raw: WalletHostMainCommand): Promise<WalletHostMainResult> {
    if (this.closed || !this.isCurrentHost(scope))
      return { ok: false, code: "CLIENT_AUTHENTICATION_REQUIRED" };
    let command;
    try {
      if (Buffer.byteLength(JSON.stringify(raw)) > WALLET_HOST_MAX_BYTES)
        return { ok: false, code: "REQUEST_TOO_LARGE" };
      command = walletHostMainCommandSchema.parse(raw);
    } catch {
      return { ok: false, code: "INVALID_REQUEST" };
    }
    const key = (callId: string) => JSON.stringify([scope.hostId, callId]);
    if (command.kind === "cancel") {
      const job = this.jobs.get(key(command.callId));
      job?.controller.abort();
      return { stopped: !!job };
    }
    if (command.kind === "agent-ready")
      return this.acceptAgent(scope.hostId, command.agent).then(() => ({ ok: true, value: null }), error => ({ ok: false, code: codeOf(error) }));
    if (command.kind === "agent-closed") {
      await this.releaseAgent(scope.hostId, command.agent);
      return { stopped: true };
    }
    if (command.kind === "image-read" || command.kind === "image-release")
      return { ok: false, code: "LEGACY_IMAGE_CHANNEL_UNAVAILABLE" };
    if (this.exhausted) return { ok: false, code: "WALLET_CHANNEL_CAPACITY" };
    if (this.jobs.has(key(command.input.callId))) return { ok: false, code: "REQUEST_CONFLICT" };
    const statusProbe = command.kind === "model-call" && command.input.method === "payment_wait_status";
    if (!walletHostHasCapacity(this.jobs.values(), statusProbe))
      return { ok: false, code: "WALLET_CHANNEL_CAPACITY" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WALLET_HOST_TIMEOUT_MS);
    timer.unref();
    const input = command.input,
      agent = command.agent;
    const job: Job = {
      statusProbe,
      hostId: scope.hostId,
      agent,
      controller,
      done: Promise.resolve({ ok: false, code: "WALLET_UNAVAILABLE" }),
    };
    job.done = Promise.resolve()
      .then(async (): Promise<WalletHostMainResult> => {
        let connection: Connection | undefined;
        try {
          if (command.kind === "model-call") {
            let connectionCurrent = () => true;
            await this.acceptAgent(scope.hostId, agent);
            const isCurrent = () => {
              const active = this.agents.get(JSON.stringify([scope.hostId, agent.workspaceKey]));
              return connectionCurrent() && !this.closed && !controller.signal.aborted && this.isCurrentHost(scope) &&
                !!active && !active.ended && sameAgent(active, agent);
            };
            const value = await this.modelPayments.call({ input: command.input, workspaceKey: agent.workspaceKey,
              signal: controller.signal, isCurrent, connect: async () => {
                await this.ensureDesktopConnection();
                const binding = this.binding, epoch = this.epoch;
                if (!binding || !isCurrent()) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
                connection = await this.connection(scope, binding, agent, command.input.invocation.sessionId, epoch, controller.signal);
                const client = await connection.ready;
                connectionCurrent = () => {
                  try { this.assertCurrent(scope, binding, epoch, controller.signal); return !connection!.closed; }
                  catch { return false; }
                };
                this.assertCurrent(scope, binding, epoch, controller.signal);
                if (connection.closed || !isCurrent()) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
                return client;
              } });
            if (!isCurrent()) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
            if (Buffer.byteLength(JSON.stringify(value)) > WALLET_HOST_MAX_BYTES) throw failure("RESPONSE_TOO_LARGE");
            return { ok: true, value };
          }
          const input = command.input;
          // Wallet-owned merchant HTTP is not offered to the Agent; it never falls back to the wallet.
          if (input.toolName === "x402_request" || input.toolName === "x402_recover_response")
            return { ok: false, code: "SERVICE_REQUEST_NOT_READY" };
          if (input.toolName === "wallet_run_client") {
            if (!this.clientRequest) return { ok: false, code: "WALLET_CLIENT_UNAVAILABLE" };
            await this.acceptAgent(scope.hostId, agent);
            const isCurrent = () => {
              const active = this.agents.get(JSON.stringify([scope.hostId, agent.workspaceKey]));
              return !this.closed && !controller.signal.aborted && this.isCurrentHost(scope) &&
                !!active && !active.ended && sameAgent(active, agent);
            };
            if (!isCurrent()) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
            this.clientInvocations.reserve(scope.hostId, agent, input.invocation);
            const context = { scope, agent, input, signal: controller.signal, isCurrent,
              connectWallet: async () => {
                if (!isCurrent()) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
                await this.ensureDesktopConnection();
                const binding = this.binding, epoch = this.epoch;
                if (!binding || !isCurrent()) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
                connection = await this.connection(scope, binding, agent, input.invocation.sessionId, epoch, controller.signal);
                const client = await connection.ready;
                const current = () => {
                  try { this.assertCurrent(scope, binding, epoch, controller.signal); return isCurrent() && !connection!.closed; }
                  catch { return false; }
                };
                if (!current()) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
                return { client, clientId: binding.clientId, isCurrent: current,
                  drainAfterDisconnect: async () => {
                    try { await this.closeConnection(connection!); }
                    catch (error) {
                      if (!this.wallet.stop) throw error;
                      await this.wallet.stop();
                      if (!connection!.processEnded) throw failure("WALLET_DRAIN_UNCERTAIN");
                    }
                  } };
              } };
            const value = await this.clientRequest(context);
            if (!isCurrent()) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
            if (Buffer.byteLength(JSON.stringify({ ok: true, value })) > WALLET_HOST_MAX_BYTES)
              return { ok: false, code: "RESPONSE_TOO_LARGE" };
            return { ok: true, value };
          }
          await this.ensureDesktopConnection();
          const binding = this.binding;
          if (!binding) throw failure("WALLET_CLIENT_NOT_CONFIGURED");
          const epoch = this.epoch;
          await this.acceptAgent(scope.hostId, agent);
          this.assertCurrent(scope, binding, epoch, controller.signal);
          connection = await this.connection(scope, binding, agent, input.invocation.sessionId, epoch, controller.signal);
          const client = await connection.ready;
          this.assertCurrent(scope, binding, epoch, controller.signal);
          if (connection.closed) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
          let value = await client.callTool(input.toolName, input.input, controller.signal);
          if (input.toolName === "wallet_get_capabilities" && value && typeof value === "object" && !Array.isArray(value)) {
            const { credentialReferences: _legacyCredentials, ...capabilities } = value as Record<string, unknown>;
            value = capabilities;
          }
          this.assertCurrent(scope, binding, epoch, controller.signal);
          const live = connection;
          await attachWalletResponseDestination(value, input.toolName, controller.signal, this.chooseDestination,
            this.wallet.approveHostDestination ? (id, directory, name) => this.wallet.approveHostDestination!(live.id, id, directory, name) : undefined,
            () => { this.assertCurrent(scope, binding, epoch, controller.signal); if (live.closed) throw failure("CLIENT_AUTHENTICATION_REQUIRED"); });
          this.assertCurrent(scope, binding, epoch, controller.signal);
          if (Buffer.byteLength(JSON.stringify({ ok: true, value })) > WALLET_HOST_MAX_BYTES)
            return { ok: false, code: "RESPONSE_TOO_LARGE" };
          return { ok: true, value };
        } catch (error) {
          // A canceled waiter can settle before the SDK. Retain Main's slot until real replies or utility drain.
          const definitive = !controller.signal.aborted && command.kind === "model-call" &&
            isFinalModelPaymentError(command.input.method, codeOf(error));
          if (connection && !statusProbe && !definitive) {
            try {
              const client = await connection.ready;
              await client.drain();
            } catch {
              try {
                await this.closeConnection(connection);
              } catch {
                job.uncertain = true;
                return { ok: false, code: "WALLET_DRAIN_UNCERTAIN" };
              }
            }
          }
          return {
            ok: false,
            code: controller.signal.aborted ? "WALLET_REQUEST_CANCELED" : codeOf(error),
          };
        }
      })
      .catch(() => ({ ok: false as const, code: "WALLET_UNAVAILABLE" }))
      .finally(() => {
        clearTimeout(timer);
        if (!job.uncertain && this.jobs.get(key(input.callId)) === job)
          this.jobs.delete(key(input.callId));
      });
    this.jobs.set(key(input.callId), job);
    return job.done;
  }

  revokeHost(hostId: string): Promise<void> {
    for (const job of this.jobs.values()) if (job.hostId === hostId) job.controller.abort();
    for (const agent of this.agents.values()) if (agent.hostId === hostId) {
      agent.ended = true;
      this.clientInvocations.clear(hostId, agent);
    }
    return Promise.all(
      [...this.connections.values()]
        .filter((value) => value.hostId === hostId)
        .map((connection) => this.closeConnection(connection)),
    ).then(() => {});
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.epoch++;
    this.binding = undefined;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.all(
      [...this.connections.values()].map((connection) => this.closeConnection(connection)),
    );
    await Promise.allSettled([...this.jobs.values()].map((job) => job.done));
  }

  private assertCurrent(scope: WalletHostScope, binding: Binding, epoch: number, signal?: AbortSignal): void {
    assertWalletCurrent(this.closed, this.epoch, epoch, this.binding, binding, this.isCurrentHost(scope), signal);
  }
  private async acceptAgent(hostId: string, agent: WalletHostAgent): Promise<void> {
    const key = JSON.stringify([hostId, agent.workspaceKey]);
    const previous = this.agents.get(key);
    if (
      previous &&
      (agent.generation < previous.generation ||
        (agent.generation === previous.generation &&
          (agent.identity !== previous.identity || previous.ended)))
    )
      throw failure("CLIENT_AUTHENTICATION_REQUIRED");
    if (!previous && this.agents.size >= MAX_AGENTS) {
      this.exhausted = true;
      throw failure("WALLET_CHANNEL_CAPACITY");
    }
    if (!previous || agent.generation > previous.generation) {
      const current = {
        ...agent,
        hostId,
        ended: false,
        ready: undefined as Promise<void> | undefined,
      };
      this.agents.set(key, current);
      current.ready = previous ? this.releaseAgent(hostId, previous, false) : Promise.resolve();
      await current.ready;
      if (current.ended) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
    } else await previous.ready;
  }

  private releaseAgent(hostId: string, agent: WalletHostAgent, end = true): Promise<void> {
    const key = JSON.stringify([hostId, agent.workspaceKey]);
    const current = this.agents.get(key);
    if (end) {
      if (!current || current.generation < agent.generation) {
        if (!current && this.agents.size >= MAX_AGENTS) this.exhausted = true;
        else this.agents.set(key, { ...agent, hostId, ended: true });
      } else if (current.identity === agent.identity && current.generation === agent.generation)
        current.ended = true;
    }
    this.clientInvocations.clear(hostId, agent);
    for (const job of this.jobs.values())
      if (job.hostId === hostId && sameAgent(job.agent, agent)) job.controller.abort();
    return Promise.all(
      [...this.connections.values()]
        .filter((value) => value.hostId === hostId && sameAgent(value.agent, agent))
        .map((connection) => this.closeConnection(connection)),
    ).then(() => {});
  }
  private isCurrentHost(scope: WalletHostScope): boolean {
    try { return this.currentHost(scope); } catch { return false; }
  }
  walletExited(): void {
    this.epoch++;
    this.binding = undefined;
    for (const job of this.jobs.values()) job.controller.abort();
    for (const connection of this.connections.values()) {
      connection.processEnded = true;
      connection.closed = true;
      connection.client?.close();
    }
    this.connections.clear();
    this.jobs.clear();
  }
  private async connection(
    scope: WalletHostScope,
    binding: Binding,
    agent: WalletHostAgent,
    chatId: string,
    epoch: number,
    signal: AbortSignal,
  ): Promise<Connection> {
    const key = JSON.stringify([scope.hostId, scope.windowId, agent.workspaceKey, agent.generation, agent.identity, chatId]);
    const existing = this.connections.get(key);
    if (existing && !existing.closed) return existing;
    if (existing) {
      try { await this.closeConnection(existing); }
      catch { throw failure("WALLET_DRAIN_UNCERTAIN"); }
      this.assertCurrent(scope, binding, epoch, signal);
      return this.connection(scope, binding, agent, chatId, epoch, signal);
    }
    if (this.connections.size >= MAX_CONNECTIONS) throw failure("WALLET_CHANNEL_CAPACITY");
    const record: Connection = {
      id: randomUUID(),
      hostId: scope.hostId,
      agent,
      closed: false,
      ready: undefined!,
    };
    const initial = binding.initialized;
    record.ready = Promise.resolve().then(async () => {
      if (initial) await initial;
      this.assertCurrent(scope, binding, epoch);
      if (record.closed) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
      const port = await this.wallet.connectHost(
        binding.clientId,
        chatId,
        initial ? "open" : binding.mode,
        record.id,
        createHash("sha256").update(JSON.stringify(["wallet.host-grant-scope.v1", scope.hostId,
          scope.windowId, agent.workspaceKey, agent.identity, agent.generation, chatId])).digest("hex"),
      );
      try {
        this.assertCurrent(scope, binding, epoch);
        if (record.closed) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
        record.client = createHostWalletChannelClient({
          send: (value) => port.postMessage(value),
          close: () => port.close(),
          subscribe: (message, closed) => {
            const receive = (event: Electron.MessageEvent) => message(event.data);
            const disconnected = () => {
              closed();
              void this.closeConnection(record).catch(() => {});
            };
            port.on("message", receive);
            port.on("close", disconnected);
            port.start();
            return () => {
              port.off("message", receive);
              port.off("close", disconnected);
            };
          },
        });
        return record.client;
      } catch (error) {
        port.close();
        await this.wallet.disconnectHost(record.id);
        throw error;
      }
    });
    if (!initial) binding.initialized = record.ready.then(() => {}, (error: unknown) => { binding.failed = true; throw error; });
    void binding.initialized?.catch(() => {});
    this.connections.set(key, record);
    return record;
  }
  private closeConnection(connection: Connection): Promise<void> {
    return closeWalletConnection(connection, this.connections, (id) => this.wallet.disconnectHost(id));
  }
}

