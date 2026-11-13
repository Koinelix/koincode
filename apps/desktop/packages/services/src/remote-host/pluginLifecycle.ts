import { randomUUID } from "node:crypto";
import { RemoteHostError } from "@fcode/shared";
import { remoteInputDigest } from "./canonicalInput.js";

interface MutationOwner { windowId: string; hostId: string }
interface Mutation { owner: MutationOwner; workspaceKey?: string }

/** One broker-wide fence for plugin facts; it never reads plugin code or grants an operation. */
export class RemotePluginLifecycle {
  private globalGeneration = randomUUID();
  private readonly workspaceGenerations = new Map<string, string>();
  private readonly mutations = new Map<string, Mutation>();
  constructor(private readonly invalidate: (workspaceKey?: string) => void) {}

  generation(workspaceKey: string): string {
    if ([...this.mutations.values()].some((mutation) => !mutation.workspaceKey || mutation.workspaceKey === workspaceKey)) {
      throw new RemoteHostError("plugin_unavailable", "Remote Host is blocked while a plugin change lacks a final receipt. Close the window that started the change or restart FCode before a fresh submission.", "authorization");
    }
    return remoteInputDigest([this.globalGeneration, this.workspaceGenerations.get(workspaceKey) ?? null]);
  }

  isCurrent(workspaceKey: string, generation: string | undefined): boolean {
    if (!generation) return false;
    try { return generation === this.generation(workspaceKey); } catch { return false; }
  }

  begin(owner: MutationOwner, mutationId: string, workspaceKey?: string): void {
    const previous = this.mutations.get(mutationId);
    if (previous) {
      this.assertOwner(previous, owner);
      if (previous.workspaceKey !== workspaceKey) throw new RemoteHostError("permission_denied", "The plugin mutation scope changed.", "authorization");
      return;
    }
    if (this.mutations.size >= 512) throw new RemoteHostError("storage_busy", "Too many plugin changes are awaiting a final receipt.");
    this.mutations.set(mutationId, { owner: { ...owner }, workspaceKey });
    this.bump(workspaceKey);
  }

  end(owner: MutationOwner, mutationId: string): void {
    const mutation = this.mutations.get(mutationId);
    if (!mutation) return;
    this.assertOwner(mutation, owner);
    this.mutations.delete(mutationId); this.bump(mutation.workspaceKey);
  }

  releaseHost(hostId: string): void {
    for (const [id, mutation] of this.mutations) if (mutation.owner.hostId === hostId) {
      this.mutations.delete(id); this.bump(mutation.workspaceKey);
    }
  }

  private bump(workspaceKey?: string): void {
    if (workspaceKey) this.workspaceGenerations.set(workspaceKey, randomUUID());
    else { this.globalGeneration = randomUUID(); this.workspaceGenerations.clear(); }
    this.invalidate(workspaceKey);
  }
  private assertOwner(mutation: Mutation, owner: MutationOwner): void {
    if (mutation.owner.hostId !== owner.hostId || mutation.owner.windowId !== owner.windowId) {
      throw new RemoteHostError("permission_denied", "This Host does not own the plugin mutation.", "authorization");
    }
  }
}
