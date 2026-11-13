import type { WalletHostAgent, WalletHostCall } from "@fcode/shared";
import { failure } from "./desktopWalletHostIdentity.js";

const MAX_CLIENT_INVOCATIONS = 50_000;

/** A tool identity is usable once within the lifetime of its authenticated agent. */
export class DesktopWalletClientInvocations {
  private readonly owners = new Map<string, Set<string>>();
  private count = 0;

  private ownerKey(hostId: string, agent: WalletHostAgent): string {
    return JSON.stringify([hostId, agent.workspaceKey, agent.identity, agent.generation]);
  }

  reserve(hostId: string, agent: WalletHostAgent, invocation: WalletHostCall["invocation"]): void {
    const owner = this.ownerKey(hostId, agent);
    const key = JSON.stringify([invocation.sessionId, invocation.turnId, invocation.toolCallId]);
    const previous = this.owners.get(owner);
    if (previous?.has(key)) throw failure("REQUEST_CONFLICT");
    if (this.count >= MAX_CLIENT_INVOCATIONS) throw failure("WALLET_CHANNEL_CAPACITY");
    const entries = previous ?? new Set<string>();
    entries.add(key);
    if (!previous) this.owners.set(owner, entries);
    this.count++;
  }

  clear(hostId: string, agent: WalletHostAgent): void {
    const owner = this.ownerKey(hostId, agent);
    const entries = this.owners.get(owner);
    if (!entries) return;
    this.count -= entries.size;
    this.owners.delete(owner);
  }
}
