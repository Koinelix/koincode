import { generalRpcChoices } from "@koincode/wallet/general";
import type { BrowserWindow } from "electron";

type Candidate = { id: string; provider: string; endpoint: string };
type Context = { window: BrowserWindow; generation: number };

/** Session-only read endpoint selection; never affects the payment or signing domains. */
export class DesktopGeneralWalletRpc {
  private selected = new Map<string, { choice: string } & Context>();
  private reads = 0;
  private selecting = false;
  private closed = false;
  private probeController?: AbortController;

  constructor(private readonly options: {
    current(context: Context): boolean;
    confirm(context: Context, networkId: string, candidate: Candidate, signal: AbortSignal): Promise<boolean>;
    prepare(): Promise<void>;
    probe(networkId: string, choice: string, signal: AbortSignal): Promise<unknown>;
    changed(networkId: string): void;
  }) {}

  choice(context: Context, networkId: string): string {
    const value = this.selected.get(networkId);
    return value && value.window === context.window && value.generation === context.generation &&
      this.options.current(context) && !this.closed ? value.choice : "default";
  }

  choices(context: Context, networkId: string): { selected: string; choices: readonly Candidate[] } {
    return { selected: this.choice(context, networkId), choices: generalRpcChoices(networkId) };
  }

  acquireRead(): () => void {
    if (this.closed || this.selecting) throw new Error("GENERAL_OPERATION_BUSY");
    this.reads++;
    let active = true;
    return () => { if (active) { active = false; this.reads--; } };
  }

  async select(context: Context, networkId: string, choice: string): Promise<void> {
    if (this.closed || this.selecting || this.reads) throw new Error("GENERAL_OPERATION_BUSY");
    const candidate = generalRpcChoices(networkId).find((item) => item.id === choice);
    if (!candidate) throw new Error("GENERAL_INVALID_REQUEST");
    if (this.choice(context, networkId) === choice) return;
    this.selecting = true;
    const controller = this.probeController = new AbortController();
    const check = () => {
      if (this.closed || controller.signal.aborted || !this.options.current(context)) throw new Error("GENERAL_STATE_CHANGED");
    };
    try {
      check();
      if (!await this.options.confirm(context, networkId, candidate, controller.signal)) throw new Error("GENERAL_RPC_DECLINED");
      check();
      await this.options.prepare();
      check();
      const value = await this.options.probe(networkId, choice, controller.signal);
      check();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GENERAL_RPC_PROBE_INVALID");
      const row = value as Record<string, unknown>;
      if (Object.keys(row).sort().join() !== "blockHash,blockNumber,networkId,rpcChoice" || row.networkId !== networkId ||
          row.rpcChoice !== choice || typeof row.blockNumber !== "string" || !/^(?:0|[1-9][0-9]{0,77})$/.test(row.blockNumber) ||
          typeof row.blockHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(row.blockHash)) throw new Error("GENERAL_RPC_PROBE_INVALID");
      this.selected.set(networkId, { ...context, choice });
      this.options.changed(networkId);
    } finally { this.probeController = undefined; this.selecting = false; }
  }

  dispose(): void { this.closed = true; this.probeController?.abort(); this.selected.clear(); }
}
