import { randomUUID } from "node:crypto";
import { REMOTE_HOST_LIMITS, RemoteHostError, type RemoteCallContext, type RemoteSessionAuthorizationOffer,
  type RemoteSessionAuthorizationTarget, type RemoteSessionAuthorizationStatus } from "@fcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { RemoteHostRepository } from "./hostRepository.js";
import type { RemoteSelectionStore } from "./selectionStore.js";
import type { RegisteredRemoteCall, RemoteClientPrincipal } from "./invocationRegistry.js";
import { remoteEndpoint } from "./hostCatalog.js";

interface ClientScope { principal: RemoteClientPrincipal; windowId: string; workspaceRoot: string }
interface Grant { grantId: string; target: RemoteSessionAuthorizationTarget; approvedAt: number }
interface Session { ownerId: string; windowId: string; workspaceKey: string; sessionId: string; brokerGeneration: string; workspaceRoot: string; grants: Map<string, Grant> }
interface Offer { sessionId: string; turnId: string; clientId: string; callId: string; key: string; value: RemoteSessionAuthorizationOffer; consumed: boolean }
const logger = createServiceLogger("remote-host-session-authorization");

/** Only trusted Main registrations supply window and workspace ownership. Grants never survive the broker. */
export class RemoteSessionAuthorizations {
  private readonly clients = new Map<string, ClientScope>();
  private readonly sessions = new Map<string, Session>();
  private readonly offers = new Map<string, Offer>();
  constructor(private readonly hosts: RemoteHostRepository, private readonly selections: RemoteSelectionStore) {}

  register(principal: RemoteClientPrincipal, windowId: string, workspaceRoot: string): void {
    this.clients.set(principal.clientInstanceId, { principal: { ...principal }, windowId, workspaceRoot });
  }
  unregister(clientId: string): void {
    this.clients.delete(clientId);
    for (const [id, offer] of this.offers) if (offer.clientId === clientId) this.offers.delete(id);
  }
  clientScope(clientId: string): { windowId: string; workspaceKey: string } | undefined {
    const scope = this.clients.get(clientId); return scope ? { windowId: scope.windowId, workspaceKey: scope.principal.workspaceKey } : undefined;
  }
  offer(call: RegisteredRemoteCall): RemoteSessionAuthorizationOffer | undefined {
    const scope = this.scope(call.context); if (!scope) return undefined;
    const selection = this.selections.forCall(call.context);
    const targets = selection.targets.map(target => this.target(target.hostId));
    if (targets.some(target => target.trustRevision === 0)) return undefined;
    const key = this.key(scope, call.context.sessionId);
    const old = this.offers.get(call.callId);
    if (old) return old.consumed ? undefined : structuredClone(old.value);
    if (this.offers.size >= REMOTE_HOST_LIMITS.sessionAuthorizationCount) throw new RemoteHostError("storage_busy", "Too many session authorization offers are pending.");
    const value = { sessionOfferId: randomUUID(), workspaceRoot: scope.workspaceRoot, targets };
    this.offers.set(call.callId, { sessionId: call.context.sessionId, turnId: call.context.turnId, clientId: call.context.clientInstanceId, key, callId: call.callId, value, consumed: false }); return structuredClone(value);
  }
  grant(call: RegisteredRemoteCall, offerId: string | undefined, responseId: string): void {
    const scope = this.scope(call.context); const offer = this.offers.get(call.callId);
    if (!scope || !offer || offer.consumed || offer.value.sessionOfferId !== offerId || offer.key !== this.key(scope, call.context.sessionId)) {
      throw new RemoteHostError("approval_mismatch", "The session authorization offer expired or belongs to another request.", "authorization");
    }
    const selection = this.selections.forCall(call.context);
    if (selection.targets.length !== offer.value.targets.length || offer.value.targets.some(target => !this.current(target) ||
      !selection.targets.some(selected => selected.hostId === target.hostId && selected.securityRevision === target.securityRevision && selected.trustRevision === target.trustRevision))) {
      throw new RemoteHostError("target_changed", "The selected hosts changed before session authorization.", "authorization");
    }
    const key = this.key(scope, call.context.sessionId);
    if (!this.sessions.has(key) && this.sessions.size >= REMOTE_HOST_LIMITS.sessionAuthorizationCount) throw new RemoteHostError("storage_busy", "The session authorization budget is full. Revoke an unused authorization first.");
    const session = this.sessions.get(key) ?? { ownerId: call.context.ownerId, windowId: scope.windowId, workspaceKey: call.context.workspaceKey,
      sessionId: call.context.sessionId, brokerGeneration: call.context.brokerGeneration, workspaceRoot: scope.workspaceRoot, grants: new Map<string, Grant>() };
    const added: string[] = [];
    for (const target of offer.value.targets) {
      const previous = session.grants.get(target.hostId);
      if (previous && this.current(previous.target)) continue;
      const grant = { grantId: randomUUID(), target: { ...target }, approvedAt: Date.now() };
      session.grants.set(target.hostId, grant); added.push(grant.grantId);
    }
    offer.consumed = true; this.sessions.set(key, session);
    logger.info(undefined, "Session authorization granted", { sessionId: session.sessionId, workspaceKey: session.workspaceKey,
      windowId: session.windowId, responseId, grantIds: added, hostIds: offer.value.targets.map(target => target.hostId) });
  }
  coverage(call: RegisteredRemoteCall): { ids: string[]; workspaceRoot: string } | undefined {
    const scope = this.scope(call.context); if (!scope) return undefined;
    const selected = this.selections.forCall(call.context);
    const session = this.sessions.get(this.key(scope, call.context.sessionId));
    if (!session || session.workspaceRoot !== scope.workspaceRoot) return undefined;
    const targets = "targets" in call.input ? call.input.targets as Array<{ hostId: string }> : [{ hostId: String(call.input.hostId) }];
    const ids: string[] = [];
    for (const target of targets) {
      const chosen = selected.targets.find(item => item.hostId === target.hostId); const grant = session.grants.get(target.hostId);
      if (!chosen || !grant || !this.current(grant.target) || chosen.securityRevision !== grant.target.securityRevision || chosen.trustRevision !== grant.target.trustRevision) return undefined;
      ids.push(grant.grantId);
    }
    return ids.length ? { ids, workspaceRoot: session.workspaceRoot } : undefined;
  }
  assertCurrent(ids: string[]): void {
    const grants = [...this.sessions.values()].flatMap(session => [...session.grants.values()]);
    if (!ids.length || ids.some(id => !grants.some(grant => grant.grantId === id && this.current(grant.target)))) {
      throw new RemoteHostError("approval_required", "The session authorization was revoked or its host changed.", "authorization");
    }
  }
  status(windowId: string, workspaceKey: string, sessionId: string): RemoteSessionAuthorizationStatus {
    const targets = [...this.sessions.values()].filter(session => session.windowId === windowId && session.workspaceKey === workspaceKey && session.sessionId === sessionId)
      .flatMap(session => [...session.grants.values()]).filter(grant => this.current(grant.target)).map(grant => ({ ...grant.target, approvedAt: grant.approvedAt }));
    return { active: targets.length > 0, targets };
  }
  revokeSession(windowId: string, workspaceKey: string, sessionId: string): string[] {
    this.invalidateOffers(parts => parts[1] === windowId && parts[2] === workspaceKey && parts[3] === sessionId);
    return this.revoke(session => session.windowId === windowId && session.workspaceKey === workspaceKey && session.sessionId === sessionId);
  }
  revokeWindow(windowId: string): string[] { this.invalidateOffers(parts => parts[1] === windowId); return this.revoke(session => session.windowId === windowId); }
  revokeWorkspace(workspaceKey: string): string[] { this.invalidateOffers(parts => parts[2] === workspaceKey); return this.revoke(session => session.workspaceKey === workspaceKey); }
  revokeHost(hostId: string): void {
    for (const offer of this.offers.values()) if (offer.value.targets.some(target => target.hostId === hostId)) offer.consumed = true;
    for (const session of this.sessions.values()) {
      const grant = session.grants.get(hostId); if (!grant) continue;
      session.grants.delete(hostId); this.auditRevoke(session, [grant.grantId]);
    }
  }
  forgetTurn(clientId: string, sessionId: string, turnId: string): void {
    for (const [id, offer] of this.offers) if (offer.clientId === clientId && offer.sessionId === sessionId && offer.turnId === turnId) this.offers.delete(id);
  }
  forgetCall(callId: string): void { this.offers.delete(callId); }
  dispose(): void { this.revoke(() => true); this.clients.clear(); this.offers.clear(); }
  windowFor(context: RemoteCallContext): string | undefined { return this.scope(context)?.windowId; }
  private scope(context: RemoteCallContext): ClientScope | undefined {
    const scope = this.clients.get(context.clientInstanceId); const p = scope?.principal;
    return p && p.ownerId === context.ownerId && p.workspaceKey === context.workspaceKey && p.agentGeneration === context.agentGeneration &&
      p.brokerGeneration === context.brokerGeneration && context.runtimeScope === "main" ? scope : undefined;
  }
  private key(scope: ClientScope, sessionId: string): string {
    const p = scope.principal; return JSON.stringify([p.ownerId, scope.windowId, p.workspaceKey, sessionId, p.brokerGeneration]);
  }
  private target(hostId: string): RemoteSessionAuthorizationTarget {
    const host = this.hosts.get(hostId); const trust = this.hosts.getTrust(hostId);
    return { hostId, securityRevision: host.securityRevision, credentialVersion: host.credentialVersion, trustRevision: trust?.trustRevision ?? 0,
      name: host.config.name, endpoint: remoteEndpoint(host.config), username: host.config.username, environment: host.config.environment };
  }
  private current(target: RemoteSessionAuthorizationTarget): boolean {
    try {
      const host = this.hosts.get(target.hostId); const trust = this.hosts.getTrust(target.hostId);
      return host.config.enabled && host.securityRevision === target.securityRevision && host.credentialVersion === target.credentialVersion &&
        Boolean(trust && trust.trustRevision === target.trustRevision && trust.endpoint === remoteEndpoint(host.config));
    } catch { return false; }
  }
  private invalidateOffers(matches: (key: string[]) => boolean): void {
    for (const offer of this.offers.values()) if (matches(JSON.parse(offer.key))) offer.consumed = true;
  }
  private revoke(matches: (session: Session) => boolean): string[] {
    const ids: string[] = [];
    for (const [key, session] of this.sessions) if (matches(session)) {
      const removed = [...session.grants.values()].map(grant => grant.grantId); ids.push(...removed);
      this.sessions.delete(key); this.auditRevoke(session, removed);
    }
    return ids;
  }
  private auditRevoke(session: Session, grantIds: string[]): void {
    logger.info(undefined, "Session authorization revoked", { sessionId: session.sessionId, workspaceKey: session.workspaceKey, windowId: session.windowId, grantIds });
  }
}
