import { randomUUID } from "node:crypto";
import { parseGeneralWalletReply, parseGeneralWalletRequest, type GeneralWalletAction, type GeneralWalletRequest } from "./desktopGeneralWalletProtocol.js";

interface Child {
  postMessage(message: unknown, transfer?: Electron.MessagePortMain[]): void;
  kill(): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "exit", listener: () => void): unknown;
}
interface Options {
  createChannel: () => Electron.MessageChannelMain;
  fork: (modulePath: string, args: string[], options: { serviceName: string; execArgv: string[]; env: Record<string, string> }) => Child;
  modulePath: string;
  env: Record<string, string>;
  timeoutMs?: number;
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup?: () => void;
  signal?: AbortSignal;
}
export class GeneralWalletProcessError extends Error {
  constructor(readonly code: string) { super(`General wallet service: ${code}`); }
}

/** Owns only the general-wallet utility and its own lifetime port and pending requests. */
export class DesktopGeneralWalletProcess {
  private child?: Child;
  private retiring?: Child;
  private port?: Electron.MessagePortMain;
  private opening?: Promise<void>;
  private ready = false;
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly options: Options) {}

  start(): Promise<void> {
    if (this.retiring) return Promise.reject(new GeneralWalletProcessError("GENERAL_PROCESS_UNAVAILABLE"));
    if (this.ready) return Promise.resolve();
    if (this.opening) return this.opening;
    let channel: Electron.MessageChannelMain | undefined;
    let child: Child | undefined;
    try {
      channel = this.options.createChannel();
      child = this.options.fork(this.options.modulePath, [], {
        serviceName: "koincode-general-wallet", execArgv: ["--no-warnings"], env: this.options.env,
      });
      this.child = child;
      this.port = channel.port1;
      const current = child;
      channel.port1.once("close", () => this.quarantine(current, "GENERAL_PROCESS_UNAVAILABLE"));
      channel.port1.start();
      child.on("message", (message) => this.receive(current, message));
      child.once("exit", () => {
        if (this.retiring === current) this.retiring = undefined;
        this.quarantine(current, "GENERAL_PROCESS_UNAVAILABLE", false);
      });
      const started = this.send({ type: "start" }, [channel.port2]).then(() => {
        if (this.child !== current) throw new GeneralWalletProcessError("GENERAL_PROCESS_UNAVAILABLE");
        this.ready = true;
      });
      this.opening = started.finally(() => { if (this.child === current) this.opening = undefined; });
      void this.opening.catch(() => this.quarantine(current, "GENERAL_PROCESS_UNAVAILABLE"));
      return this.opening;
    } catch {
      try { channel?.port1.close(); } catch { /* best effort */ }
      try { channel?.port2.close(); } catch { /* best effort */ }
      if (child) this.quarantine(child, "GENERAL_PROCESS_UNAVAILABLE");
      return Promise.reject(new GeneralWalletProcessError("GENERAL_PROCESS_UNAVAILABLE"));
    }
  }

  async request(action: GeneralWalletAction): Promise<unknown> {
    if (action !== "status" && action !== "networks") throw new GeneralWalletProcessError("GENERAL_INVALID_REQUEST");
    await this.start();
    return this.send({ type: action });
  }

  async probeRpc(networkId: string, rpcChoice: string, signal?: AbortSignal): Promise<unknown> {
    const request = { type: "probe_rpc" as const, id: randomUUID(), networkId, rpcChoice };
    if (!parseGeneralWalletRequest(request)) throw new GeneralWalletProcessError("GENERAL_INVALID_REQUEST");
    await this.start();
    return this.send({ type: "probe_rpc", networkId, rpcChoice }, undefined, signal);
  }

  async balances(networkId: string, address: string, cacheScope: string, signal?: AbortSignal, rpcChoice?: string): Promise<unknown> {
    const request = { type: "balances" as const, id: randomUUID(), networkId, address, cacheScope, ...(rpcChoice === undefined ? {} : { rpcChoice }) };
    if (!parseGeneralWalletRequest(request)) throw new GeneralWalletProcessError("GENERAL_INVALID_REQUEST");
    await this.start();
    return this.send({ type: "balances", networkId, address, cacheScope, ...(rpcChoice === undefined ? {} : { rpcChoice }) }, undefined, signal);
  }

  async customBalances(networkId: string, address: string, cacheScope: string,
    assets: Array<{ contractAddress: string; expectedDecimals?: number }>, signal?: AbortSignal, rpcChoice?: string): Promise<unknown> {
    const request = { type: "custom_balances" as const, id: randomUUID(), networkId, address, cacheScope, assets, ...(rpcChoice === undefined ? {} : { rpcChoice }) };
    if (!parseGeneralWalletRequest(request)) throw new GeneralWalletProcessError("GENERAL_INVALID_REQUEST");
    await this.start();
    return this.send({ type: "custom_balances", networkId, address, cacheScope, assets, ...(rpcChoice === undefined ? {} : { rpcChoice }) }, undefined, signal);
  }

  async receiveAddress(networkId: string, address: string, assetId: string): Promise<unknown> {
    if (!/^eip155:[1-9][0-9]{0,19}$/.test(networkId) || !/^0x[0-9a-fA-F]{40}$/.test(address) ||
        !/^(?:native|erc20:0x[0-9a-f]{40})$/.test(assetId)) throw new GeneralWalletProcessError("GENERAL_INVALID_REQUEST");
    await this.start();
    return this.send({ type: "receive", networkId, address, assetId });
  }

  async inspectToken(networkId: string, address: string, contractAddress: string, signal?: AbortSignal, rpcChoice?: string): Promise<unknown> {
    const request = { type: "inspect_token" as const, id: randomUUID(), networkId, address, contractAddress, ...(rpcChoice === undefined ? {} : { rpcChoice }) };
    if (!parseGeneralWalletRequest(request)) throw new GeneralWalletProcessError("GENERAL_INVALID_REQUEST");
    await this.start();
    return this.send({ type: "inspect_token", networkId, address, contractAddress, ...(rpcChoice === undefined ? {} : { rpcChoice }) }, undefined, signal);
  }

  stop(): void {
    if (this.child) this.quarantine(this.child, "GENERAL_PROCESS_UNAVAILABLE");
  }

  private send(command: Omit<Extract<GeneralWalletRequest, { type: "probe_rpc" }>, "id"> | Omit<Extract<GeneralWalletRequest, { type: "balances" }>, "id"> |
    Omit<Extract<GeneralWalletRequest, { type: "custom_balances" }>, "id"> |
    Omit<Extract<GeneralWalletRequest, { type: "inspect_token" }>, "id"> |
    Omit<Extract<GeneralWalletRequest, { type: "receive" }>, "id"> | { type: "start" | GeneralWalletAction },
    transfer?: Electron.MessagePortMain[], signal?: AbortSignal): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new GeneralWalletProcessError("GENERAL_PROCESS_UNAVAILABLE"));
    if (signal?.aborted) return Promise.reject(new GeneralWalletProcessError("GENERAL_BALANCE_READ_CANCELED"));
    if (this.pending.size >= 32) return Promise.reject(new GeneralWalletProcessError("GENERAL_OPERATION_BUSY"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.quarantine(child, "GENERAL_OPERATION_TIMEOUT"), this.options.timeoutMs ?? 30000);
      timer.unref();
      const cancel = () => {
        if (this.child !== child || !this.pending.has(id)) return;
        try { child.postMessage({ type: "cancel", id }); }
        catch { this.quarantine(child, "GENERAL_PROCESS_UNAVAILABLE"); }
      };
      const cleanup = () => signal?.removeEventListener("abort", cancel);
      this.pending.set(id, { resolve, reject, timer, cleanup, signal });
      try {
        child.postMessage({ ...command, id }, transfer);
        if (this.pending.has(id)) {
          signal?.addEventListener("abort", cancel, { once: true });
          if (signal?.aborted) cancel();
        }
      }
      catch {
        for (const port of transfer ?? []) { try { port.close(); } catch { /* best effort */ } }
        this.quarantine(child, "GENERAL_PROCESS_UNAVAILABLE");
      }
    });
  }

  private receive(child: Child, raw: unknown): void {
    if (this.child !== child) return;
    const reply = parseGeneralWalletReply(raw);
    if (!reply) { this.quarantine(child, "GENERAL_PROCESS_UNAVAILABLE"); return; }
    const pending = this.pending.get(reply.id);
    if (!pending) { this.quarantine(child, "GENERAL_PROCESS_UNAVAILABLE"); return; }
    clearTimeout(pending.timer);
    pending.cleanup?.();
    this.pending.delete(reply.id);
    if (pending.signal?.aborted) pending.reject(new GeneralWalletProcessError("GENERAL_BALANCE_READ_CANCELED"));
    else if (reply.ok) pending.resolve(reply.value);
    else pending.reject(new GeneralWalletProcessError(reply.code));
  }

  private quarantine(child: Child, code: string, kill = true): void {
    if (this.child !== child) return;
    this.child = undefined;
    if (kill) this.retiring = child;
    this.ready = false;
    this.opening = undefined;
    const port = this.port;
    this.port = undefined;
    try { port?.close(); } catch { /* best effort */ }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(new GeneralWalletProcessError(code));
    }
    this.pending.clear();
    if (kill) { try { child.kill(); } catch { /* already gone */ } }
  }
}
