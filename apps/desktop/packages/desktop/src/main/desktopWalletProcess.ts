import { receiveStorageProgress, failWalletReplies, migrateWalletStorage, openWalletPrivateManagementPort, sendWalletCommand, closeWalletPort, DesktopWalletError, reportWalletStartupFailure, reportWalletExit, walletRuntimeAssetsAvailable, type WalletChild, type WalletDiagnosticSink, type PendingWalletReply as Pending } from "./desktopWalletProcessSupport.js";
export { DesktopWalletError } from "./desktopWalletProcessSupport.js";
import { DesktopWalletOutboundBroker } from "./desktopWalletOutboundBroker.js";
import { DesktopWalletPaymentBroker } from "./desktopWalletPaymentBroker.js";
import {
  isWalletMessage,
  type WalletControlCommand,
  type WalletStartMode,
} from "./desktopWalletProtocol.js";

interface WalletProcessOptions {
  createChannel: () => Electron.MessageChannelMain;
  fork: (
    modulePath: string,
    args: string[],
    options: { serviceName: string; execArgv: string[]; env: Record<string, string> },
  ) => WalletChild;
  modulePath: string;
  runtimeAssetsAvailable?: (modulePath: string) => boolean;
  keychainHelper: string;
  env: Record<string, string>;
  requestTimeoutMs?: number;
  /** Receives fixed lifecycle metadata only; Main routes it to the file log. */
  report?: WalletDiagnosticSink;
  stopTimeoutMs?: number;
}
export type WalletStateInvalidation = "changed" | "interaction_canceled" | "lock_requested" | "exited" | "startup_failed" | "maintenance_finished" | "profile_opened";

/** Owns one optional utility process. It never starts from a renderer or model request. */
export class DesktopWalletProcess {
  private child?: WalletChild;
  private parentConnection?: { child: WalletChild; port: Electron.MessagePortMain };
  private opening?: Promise<void>;
  private openingMode?: WalletStartMode;
  private startupFailureChild?: WalletChild;
  private readyChild?: WalletChild;
  private stopping?: Promise<void>;
  private disposed = false;
  private lockGeneration = 0;
  private uncertainChild?: WalletChild;
  private observationGeneration = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly terminationReasons = new WeakMap<WalletChild, "stopped" | "quarantined">();
  private readonly quarantineCauses = new WeakMap<WalletChild, string>();
  private readonly activeManagement = new Map<WalletChild, number>();
  private readonly stateListeners = new Set<(reason: WalletStateInvalidation) => void>();
  private readonly stateNotifications: WalletStateInvalidation[] = [];
  private notifying = false;
  private exited?: Promise<void>;
  readonly outbound = new DesktopWalletOutboundBroker(
    (body) => this.send(body),
    () => this.isReady(),
    () => this.lockForHostEvent(),
  );
  readonly payments = new DesktopWalletPaymentBroker((body) => this.send(body), () => this.isReady(), () => this.lockForHostEvent());
  private isReady(): boolean {
    return !!this.child && this.readyChild === this.child && this.uncertainChild !== this.child && !this.stopping && !this.disposed;
  }
  constructor(private readonly options: WalletProcessOptions) {}
  start(mode: WalletStartMode): Promise<void> {
    if (this.disposed || this.stopping)
      return Promise.reject(new DesktopWalletError("WALLET_STOPPING"));
    if (this.child && this.child === this.uncertainChild)
      return Promise.reject(new DesktopWalletError("WALLET_LOCK_UNCERTAIN"));
    if (this.opening)
      return mode === "open" || (this.openingMode === mode && this.readyChild !== this.child)
        ? this.opening
        : Promise.reject(new DesktopWalletError("WALLET_ALREADY_OPEN"));
    if (this.child) return Promise.reject(new DesktopWalletError("WALLET_ALREADY_OPEN"));
    if (
      !(this.options.runtimeAssetsAvailable ?? walletRuntimeAssetsAvailable)(
        this.options.modulePath,
      )
    )
      return Promise.reject(new DesktopWalletError("WALLET_RUNTIME_UNAVAILABLE"));
    let channel: Electron.MessageChannelMain | undefined;
    let child: WalletChild;
    try {
      channel = this.options.createChannel();
      child = this.options.fork(this.options.modulePath, [], {
        serviceName: "koincode-wallet",
        execArgv: ["--no-warnings"],
        env: this.options.env,
      });
    } catch {
      this.closePort(channel?.port1);
      this.closePort(channel?.port2);
      return Promise.reject(new DesktopWalletError("WALLET_UNAVAILABLE"));
    }
    this.child = child;
    this.parentConnection = { child, port: channel.port1 };
    this.exited = new Promise<void>((resolve) => {
      child.once("exit", (code) => {
        reportWalletExit(mode, code, this.terminationReasons.get(child) ?? "unexpected", this.child === child ? this.pending.size : 0, this.quarantineCauses.get(child), this.options.report);
        this.closeParentConnection(child);
        if (this.child === child) {
          this.lockGeneration++;
          if (this.uncertainChild === child) this.uncertainChild = undefined;
          this.child = undefined;
          if (this.readyChild === child) this.readyChild = undefined;
          this.opening = undefined;
          this.openingMode = undefined;
          failWalletReplies(this.pending, "WALLET_PROCESS_EXITED");
          this.outbound.invalidate(); this.payments.invalidate();
          this.invalidateState(this.startupFailureChild === child ? "startup_failed" : mode === "storage_maintenance" ? "maintenance_finished" : "exited");
          if (this.startupFailureChild === child) this.startupFailureChild = undefined;
        }
        resolve();
      });
    });
    channel.port1.once("close", () => {
      if (this.parentConnection?.child === child) this.quarantine(child, true, "parent_port_closed");
    });
    try {
      channel.port1.start();
    } catch {
      this.closePort(channel.port2);
      this.quarantine(child, true, "parent_port_start_failed");
      return Promise.reject(new DesktopWalletError("WALLET_UNAVAILABLE"));
    }
    child.on("message", (message) => {
      if (this.child !== child) return;
      if (receiveStorageProgress(message, this.pending) || this.outbound.receive(message) || this.payments.receive(message)) return;
      if (
        !isWalletMessage(message) ||
        message.type !== "reply" ||
        typeof message.id !== "string" ||
        typeof message.ok !== "boolean"
      )
        return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else
        pending.reject(
          new DesktopWalletError(
            typeof message.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(message.code)
              ? message.code
              : "WALLET_UNAVAILABLE",
          ),
        );
    });
    const opening = this.send(
      {
        type: "start",
        mode,
        keychainHelper: this.options.keychainHelper,
      },
      [channel.port2],
    )
      .then(() => {
        if (this.stopping || this.disposed || this.child !== child)
          throw new DesktopWalletError("WALLET_STOPPING");
        this.assertHealthy(child);
        this.readyChild = child;
        if (mode === "import_setup") this.invalidateState("profile_opened");
      })
      .finally(() => {
        if (this.child === child) this.invalidateState("changed");
      });
    this.opening = opening;
    this.openingMode = mode;
    void opening.catch((error: unknown) => {
      this.startupFailureChild = child;
      reportWalletStartupFailure(mode, error, this.options.report);
      this.closePort(channel.port2);
      if (this.child === child && !this.stopping) this.quarantine(child, false, "startup_failed");
    });
    this.invalidateState("changed");
    return opening;
  }
  list(): Promise<unknown> { return this.observeWallet({ type: "list" }); }
  async allowance(command: import("./desktopWalletProtocol.js").WalletAllowanceCommand): Promise<unknown> {
    const generation = this.observationGeneration;
    await this.requireOpen();
    this.assertObservation(generation);
    return this.send({ type: "wallet-allowance", command });
  }
  async inspectWallet(walletId: string, section: "clients" | "grants" | "payments", offset = 0, displayOnly = false): Promise<unknown> {
    return this.observeWallet({ type: displayOnly ? "inspect-wallet-display" : "inspect-wallet", walletId, section, offset });
  }
  private async observeWallet(command: Record<string, unknown>): Promise<unknown> {
    const generation = this.observationGeneration;
    this.assertNoManagement(); await this.requireOpen();
    this.assertObservation(generation); this.assertNoManagement();
    const result = await this.send(command);
    this.assertObservation(generation); this.assertNoManagement();
    return result;
  }
  /** Trusted host wiring only. Never exposed as a renderer management command. */
  async connectHost(clientId: string, chatId: string, mode: "create" | "open", connectionId?: string, hostGrantScope?: string): Promise<Electron.MessagePortMain> {
    await this.requireOpen();
    const child = this.child;
    const channel = this.options.createChannel();
    let ended = false;
    const onClose = () => { ended = true; };
    const onEarlyMessage = () => { ended = true; this.closePort(channel.port1); };
    channel.port1.once("close", onClose);
    channel.port1.on("message", onEarlyMessage);
    try {
      // Electron queues close events until the endpoint is started.
      channel.port1.start();
      this.assertHealthy(child);
      await this.send({ type: "host-connect", clientId, chatId, mode, ...(connectionId ? { connectionId, ...(this.payments.available() ? { paymentUi: true } : {}) } : {}),
        ...(hostGrantScope === undefined ? {} : { hostGrantScope }) }, [channel.port2]);
      this.assertHealthy(child);
      if (this.stopping || this.disposed || ended) throw new DesktopWalletError("WALLET_CHANNEL_CLOSED");
      return channel.port1;
    } catch (error) {
      this.closePort(channel.port1);
      this.closePort(channel.port2);
      throw error;
    } finally {
      channel.port1.off("close", onClose);
      channel.port1.off("message", onEarlyMessage);
    }
  }
  stateGeneration(): number { return this.observationGeneration; }
  async openExisting(): Promise<void> {
    if (this.child) await this.requireOpen();
    else await this.start("open");
  }
  /** Private management connection; never passed to a renderer, SDK or Skill. */
  openGeneralManagement(initializeImport = false): Promise<Electron.MessagePortMain> {
    return openWalletPrivateManagementPort(() => initializeImport && !this.child ? this.start("import_setup") : this.openExisting(), () => this.options.createChannel(), (body, ports) => this.send(body, ports));
  }
  async ensureDesktopClient(): Promise<{ clientId: string; mode: "open" }> {
    await this.requireOpen();
    const value = await this.send({ type: "desktop-connect" });
    if (!value || typeof value !== "object" || !("clientId" in value) || !("mode" in value) ||
      typeof value.clientId !== "string" || !/^[0-9a-f-]{36}$/.test(value.clientId) || value.mode !== "open")
      throw new DesktopWalletError("WALLET_INVALID_RESPONSE");
    return { clientId: value.clientId, mode: "open" };
  }
  async disconnectHost(connectionId: string): Promise<void> {
    await this.requireOpen();
    await this.send({ type: "host-disconnect", connectionId });
  }
  async approveHostDestination(connectionId: string, requestId: string, directory: string, name: string): Promise<string> {
    await this.requireOpen();
    const ref = await this.send({ type: "host-approve-destination", connectionId, requestId, directory, name });
    if (typeof ref !== "string" || !/^wallet-destination:[0-9a-f-]{36}$/.test(ref)) throw new DesktopWalletError("WALLET_INVALID_RESPONSE");
    return ref;
  }
  invalidateDisplayObservation(): void { this.invalidateState("changed"); }
  onStateInvalidated(listener: (reason: WalletStateInvalidation) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }
  async manage(command: WalletControlCommand): Promise<unknown> {
    const generation = this.lockGeneration;
    const frozen = structuredClone(command);
    if (frozen.action === "lock") this.lockForHostEvent();
    const child = this.child;
    if (child) this.activeManagement.set(child, (this.activeManagement.get(child) ?? 0) + 1);
    this.invalidateState("changed");
    try {
      await this.requireOpen();
      if (frozen.action === "unlock" && generation !== this.lockGeneration)
        throw new DesktopWalletError("WALLET_LOCKED");
      const result = await this.send({ type: "manage", command: frozen });
      this.assertHealthy(child);
      return result;
    } finally {
      if (child) {
        const remaining = (this.activeManagement.get(child) ?? 1) - 1;
        if (remaining) this.activeManagement.set(child, remaining);
        else this.activeManagement.delete(child);
      }
      if (this.child === child) this.invalidateState("changed");
    }
  }
  cancelHostInteraction(): void {
    this.lockGeneration++;
    this.outbound.invalidate(); this.payments.invalidate();
    const child = this.child;
    this.invalidateState("interaction_canceled", () => {
      if (!child) return;
      try { child.postMessage({ type: "interaction-event" }); }
      catch { this.quarantine(child, false, "interaction_event_failed"); }
    });
  }
  lockForHostEvent(): void {
    this.lockGeneration++;
    this.outbound.invalidate(); this.payments.invalidate();
    const child = this.child;
    this.invalidateState("lock_requested", () => {
      if (!child) return;
      try { child.postMessage({ type: "lock-event" }); }
      catch { this.quarantine(child, false, "lock_event_failed"); }
    });
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child) return Promise.resolve();
    this.terminationReasons.set(child, "stopped");
    this.lockForHostEvent();
    const exited = this.exited!;
    this.stopping = (async () => {
      let force: ReturnType<typeof setTimeout>;
      const deadline = new Promise<void>((resolve) => {
        force = setTimeout(() => {
          this.terminate(child, "stopped");
          resolve();
        }, this.options.stopTimeoutMs ?? 2000);
      });
      try {
        await Promise.race([this.send({ type: "stop" }).catch(() => {}), exited, deadline]);
        this.terminate(child, "stopped");
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
      } finally {
        clearTimeout(force!);
      }
      if (this.child === child) throw new DesktopWalletError("WALLET_STOP_TIMEOUT");
    })().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
  /** Trusted private wallet window only. */
  migrateStorage(confirm: (summary: { records: number; domains: number }) => Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
    this.assertNoManagement();
    return migrateWalletStorage(() => this.stop(), () => this.start("storage_maintenance"),
      body => this.send(body, [], 180000), confirm, signal);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
  }
  private async requireOpen(): Promise<void> {
    if (this.disposed || this.stopping || !this.child || !this.opening)
      throw new DesktopWalletError("WALLET_NOT_OPEN");
    const child = this.child,
      opening = this.opening;
    this.assertHealthy(child);
    await opening;
    if (this.child !== child || this.stopping || this.disposed)
      throw new DesktopWalletError("WALLET_NOT_OPEN");
    this.assertHealthy(child);
  }
  private assertHealthy(child: WalletChild | undefined): void {
    if (child && this.uncertainChild === child)
      throw new DesktopWalletError("WALLET_LOCK_UNCERTAIN");
    if (!child || this.child !== child) throw new DesktopWalletError("WALLET_PROCESS_EXITED");
  }
  private terminate(child: WalletChild, reason: "stopped" | "quarantined" = "quarantined"): void {
    this.terminationReasons.set(child, reason);
    this.closeParentConnection(child);
    try { child.kill(); }
    catch { /* Exit is not assumed until the child exit event is observed. */ }
  }
  private readonly closePort = closeWalletPort;
  private closeParentConnection(child: WalletChild): void {
    if (this.parentConnection?.child !== child) return;
    const port = this.parentConnection.port;
    this.parentConnection = undefined;
    this.closePort(port);
  }
  private quarantine(child: WalletChild, notify = true, cause = "unspecified"): void {
    if (this.child !== child) return;
    if (!this.quarantineCauses.has(child)) this.quarantineCauses.set(child, cause);
    this.uncertainChild = child;
    this.outbound.invalidate(); this.payments.invalidate();
    this.lockGeneration++;
    this.terminate(child);
    if (notify && this.child === child) this.invalidateState("lock_requested");
  }
  private assertObservation(generation: number): void {
    if (generation !== this.observationGeneration)
      throw new DesktopWalletError("WALLET_STATE_INVALIDATED");
  }
  private assertNoManagement(): void {
    if (this.child && (this.activeManagement.get(this.child) ?? 0) > 0) {
      throw new DesktopWalletError("WALLET_STATE_INVALIDATED");
    }
  }
  private invalidateState(reason: WalletStateInvalidation, beforeNotify?: () => void): void {
    const generation = ++this.observationGeneration;
    beforeNotify?.();
    if (generation !== this.observationGeneration) return;
    this.stateNotifications.push(reason);
    if (this.notifying) return;
    this.notifying = true;
    try {
      while (this.stateNotifications.length) {
        const current = this.stateNotifications.shift()!;
        for (const listener of Array.from(this.stateListeners)) {
          if (!this.stateListeners.has(listener)) continue;
          try {
            listener(current);
          } catch {
            /* Observers cannot break process cleanup. */
          }
        }
      }
    } finally {
      this.notifying = false;
    }
  }
  private send(body: Record<string, unknown>, transfer?: Electron.MessagePortMain[], timeout = this.options.requestTimeoutMs ?? 30000): Promise<unknown> {
    return sendWalletCommand(this.child, this.pending, body, transfer, timeout,
      (child, cause) => this.quarantine(child, true, cause), () => this.child);
  }
}
