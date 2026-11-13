import { randomBytes, randomUUID } from "node:crypto";
import { requireWallet, WalletError } from "../domain/errors.js";
import type { ClientContext } from "../domain/model.js";
import type { GuardedWalletState } from "./guardedState.js";
import type { WalletState } from "./state.js";
declare const clientHandleBrand: unique symbol;
export type ClientHandle = { readonly [clientHandleBrand]: true };
export class WalletSessions {
  #handles = new Map<ClientHandle, ClientContext>();
  #lifetimes = new Map<ClientHandle, { scope: string; controller: AbortController }>();
  #pending = 0;
  #closed = false;
  #blockedClients = new Set<string>();
  constructor(private readonly owner: GuardedWalletState) {}
  async connect(clientId: string, internalChatId?: string, hostGrantScope?: string): Promise<ClientHandle> {
    requireWallet(
      !this.#closed &&
        !this.#blockedClients.has(clientId) &&
        this.#handles.size + this.#pending < 128,
      "CLIENT_CAPACITY_EXCEEDED",
      "The wallet has too many active connections.",
    );
    this.#pending++;
    try {
      const context = await this.owner.mutate((state) => {
        const client = state.clients.find(
          (client) => client.clientId === clientId && client.active,
        );
        requireWallet(
          client && client.ownerId === state.ownerId,
          "CLIENT_NOT_FOUND",
          "The registered client is unavailable.",
        );
        requireWallet(
          internalChatId === undefined ||
            (client.kind === "internal" &&
              internalChatId.length > 0 &&
              internalChatId.length <= 256),
          "CLIENT_CONTEXT_INVALID",
          "An external client cannot select a trusted host chat.",
        );
        requireWallet(hostGrantScope === undefined ||
          (client.kind === "internal" && internalChatId !== undefined && /^[0-9a-f]{64}$/.test(hostGrantScope)),
        "CLIENT_CONTEXT_INVALID", "The host grant scope is invalid.");
        const sessionId = internalChatId ?? randomUUID();
        const existing = state.sessions.find(
          (session) =>
            session.clientId === clientId &&
            session.sessionId === sessionId &&
            session.generation === client.generation,
        );
        if (existing) return existing;
        const context: ClientContext = {
          ownerId: state.ownerId,
          clientId,
          sessionId,
          generation: client.generation,
          identityLevel: "token_only",
        };
        state.sessions.push(context);
        return context;
      });
      requireWallet(
        !this.#closed && !this.#blockedClients.has(clientId),
        "CLIENT_AUTHENTICATION_REQUIRED",
        "The client was closed while connecting.",
      );
      const handle = Object.freeze({}) as ClientHandle;
      this.#handles.set(handle, context);
      this.#lifetimes.set(handle, { scope: hostGrantScope ?? randomBytes(32).toString("hex"), controller: new AbortController() });
      return handle;
    } finally {
      this.#pending--;
    }
  }
  hostGrantScope(handle: ClientHandle): string | undefined {
    this.resolve(handle);
    return this.#lifetimes.get(handle)?.scope;
  }
  invalidationSignal(handle: ClientHandle): AbortSignal {
    const lifetime = this.#lifetimes.get(handle);
    requireWallet(lifetime, "CLIENT_AUTHENTICATION_REQUIRED", "The original wallet session has ended.");
    return lifetime.controller.signal;
  }
  private invalidateHandle(handle: ClientHandle): void {
    const lifetime = this.#lifetimes.get(handle);
    this.#handles.delete(handle);
    this.#lifetimes.delete(handle);
    lifetime?.controller.abort(new WalletError("CLIENT_AUTHENTICATION_REQUIRED", "The original wallet session has ended."));
  }
  resolve(handle: ClientHandle, state = this.owner.snapshot()): ClientContext {
    const context = this.#handles.get(handle);
    requireWallet(
      context,
      "CLIENT_AUTHENTICATION_REQUIRED",
      "An authenticated wallet connection is required.",
    );
    const client = state.clients.find(
      (client) =>
        client.clientId === context.clientId &&
        client.active &&
        client.generation === context.generation,
    );
    requireWallet(
      client &&
        client.ownerId === state.ownerId &&
        context.ownerId === state.ownerId &&
        state.sessions.some(
          (session) =>
            session.clientId === context.clientId &&
            session.sessionId === context.sessionId &&
            session.generation === context.generation,
        ),
      "CLIENT_AUTHENTICATION_REQUIRED",
      "The wallet connection is no longer active.",
    );
    return { ...context };
  }
  requireSubject(handle: ClientHandle, subjectId: string, state: WalletState): ClientContext {
    const context = this.resolve(handle, state);
    requireWallet(
      state.subjects.some(
        (subject) => subject.subjectId === subjectId && subject.ownerId === state.ownerId,
      ) &&
        state.clients
          .find((client) => client.clientId === context.clientId)
          ?.subjectIds.includes(subjectId),
      "WALLET_NOT_FOUND",
      "The wallet is outside this client's scope.",
    );
    return context;
  }
  async disconnect(handle: ClientHandle): Promise<void> {
    const context = this.#handles.get(handle);
    this.invalidateHandle(handle);
    if (!context) return;
    await this.owner.mutate((state) => {
      const client = state.clients.find((client) => client.clientId === context.clientId);
      if (client?.kind === "external")
        state.sessions = state.sessions.filter(
          (session) =>
            !(session.clientId === context.clientId && session.sessionId === context.sessionId),
        );
    });
  }
  invalidateOthers(clientId: string, keep: ClientHandle): void {
    const current = this.#handles.get(keep);
    requireWallet(
      current?.clientId === clientId,
      "CLIENT_AUTHENTICATION_REQUIRED",
      "The retained client connection is invalid.",
    );
    for (const [handle, context] of this.#handles)
      if (context.clientId === clientId && handle !== keep) {
        this.invalidateHandle(handle);
      }
  }
  invalidateClient(clientId: string): void {
    this.#blockedClients.add(clientId);
    for (const [handle, context] of this.#handles)
      if (context.clientId === clientId) {
        this.invalidateHandle(handle);
      }
  }
  allowClient(clientId: string): void {
    requireWallet(
      this.owner.snapshot().clients.some((client) => client.clientId === clientId && client.active),
      "CLIENT_NOT_FOUND",
      "The client is not active.",
    );
    this.#blockedClients.delete(clientId);
  }
  close(): void {
    this.#closed = true;
    for (const handle of this.#handles.keys()) this.invalidateHandle(handle);
  }
}
