import { randomUUID } from "node:crypto";
import {
  REMOTE_HOST_LIMITS, RemoteHostError, remoteHostFailure,
  type RemoteCallContext, type RemoteHostRecord, type RemoteSshConnection, type RemoteSshTransportPort, type RemoteTestResult,
} from "@fcode/shared";
import { RemoteHostRepository } from "./hostRepository.js";
import { RemoteSecretVault } from "./secretVault.js";
import { RemoteTrustAuthority } from "./trustAuthority.js";
import { RemoteSessionConnectionPool } from "./sessionConnectionPool.js";
import { sessionConnectionLease, type RemoteConnectionLease } from "./connectionLease.js";

/** A new connection must always be tied to one coordinator-owned authorization callback. */
export class RemoteConnectionManager {
  private readonly connections = new Map<string, { hostId: string; connection?: RemoteSshConnection; controller: AbortController }>();
  readonly pool: RemoteSessionConnectionPool;
  constructor(
    private readonly repository: RemoteHostRepository,
    private readonly vault: RemoteSecretVault,
    private readonly trust: RemoteTrustAuthority,
    private readonly transport: RemoteSshTransportPort,
    poolOptions: { idleMs?: number; maxConnections?: number } = {},
  ) { this.pool = new RemoteSessionConnectionPool(poolOptions); }

  async acquire(context: RemoteCallContext, host: RemoteHostRecord, assertAuthorized: () => void, signal?: AbortSignal): Promise<RemoteConnectionLease> {
    const trustRevision = this.repository.getTrust(host.hostId)?.trustRevision ?? 0;
    const check = () => {
      signal?.throwIfAborted(); assertAuthorized();
      const current = this.repository.get(host.hostId);
      if (!current.config.enabled || current.securityRevision !== host.securityRevision || current.credentialVersion !== host.credentialVersion ||
        (this.repository.getTrust(host.hostId)?.trustRevision ?? 0) !== trustRevision) {
        throw new RemoteHostError("target_changed", "The cached SSH connection no longer matches the selected host.");
      }
    };
    const key = JSON.stringify([context.ownerId, context.workspaceKey, context.sessionId, context.clientInstanceId,
      context.agentGeneration, context.brokerGeneration, host.hostId, host.securityRevision, host.credentialVersion, trustRevision]);
    const borrowed = await this.pool.acquire({ key, hostId: host.hostId, clientId: context.clientInstanceId,
      sessionId: context.sessionId, check, signal, connect: async (assertAny, connectionSignal) => {
        const physical = await this.open(host, assertAny, connectionSignal);
        // An idle transport must not retain plaintext redaction material from its handshake.
        physical.redactionValues.length = 0;
        return physical;
      } });
    try {
      check();
      const material = await this.vault.get(host, this.repository.getProtectedSecret(host.hostId));
      check();
      return sessionConnectionLease(borrowed.connection, [material.password, material.passphrase].filter((value): value is string => Boolean(value)), check, borrowed.release, signal);
    } catch (error) { borrowed.release(); throw error; }
  }

  async open(host: RemoteHostRecord, assertAuthorized: () => void, signal?: AbortSignal): Promise<{ connection: RemoteSshConnection; redactionValues: string[]; release(): void }> {
    signal?.throwIfAborted();
    assertAuthorized();
    const id = randomUUID();
    const controller = new AbortController();
    const redactionValues: string[] = [];
    const record: { hostId: string; connection?: RemoteSshConnection; controller: AbortController } = { hostId: host.hostId, controller };
    this.connections.set(id, record);
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      controller.abort(signal?.reason);
      if (record.connection && !closeTimer) {
        closeTimer = setTimeout(() => record.connection?.close(), REMOTE_HOST_LIMITS.cancelWaitMs + 100);
        closeTimer.unref();
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    const assertCurrent = () => {
      controller.signal.throwIfAborted(); assertAuthorized();
      const current = this.repository.get(host.hostId);
      if (!current.config.enabled) throw new RemoteHostError("host_disabled", "The host is disabled.");
      if (current.securityRevision !== host.securityRevision) throw new RemoteHostError("target_changed", "The host's security configuration changed.");
    };
    try {
      const previousTrust = this.repository.getTrust(host.hostId);
      const connection = await this.transport.connect({ host, preferredHostKeyType: previousTrust?.keyType,
        signal: controller.signal,
        verifyHostKey: (key) => { assertCurrent(); this.trust.verify(host, key); },
        getCredential: async () => {
          assertCurrent();
          const material = await this.vault.get(host, this.repository.getProtectedSecret(host.hostId));
          assertCurrent();
          for (const value of [material.password, material.passphrase]) if (value) redactionValues.push(value);
          return material;
        },
      });
      record.connection = connection;
      assertCurrent();
      return { connection, redactionValues, release: () => {
        clearTimeout(closeTimer);
        signal?.removeEventListener("abort", abort);
        connection.close(); redactionValues.length = 0; this.connections.delete(id);
      } };
    } catch (error) {
      clearTimeout(closeTimer);
      signal?.removeEventListener("abort", abort);
      record.connection?.close(); this.connections.delete(id);
      throw error;
    }
  }

  /** Management context is explicit and is never registered as a chat execution grant. */
  async test(hostId: string, expectedSecurityRevision: number, signal?: AbortSignal): Promise<RemoteTestResult> {
    const checkedAt = Date.now();
    const host = this.repository.get(hostId);
    if (host.securityRevision !== expectedSecurityRevision) throw new RemoteHostError("target_changed", "Reload the host before testing it.");
    const deadline = AbortSignal.timeout(REMOTE_HOST_LIMITS.handshakeMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let lease: Awaited<ReturnType<RemoteConnectionManager["open"]>> | undefined;
    try {
      lease = await this.open(host, () => combined.throwIfAborted(), combined);
      combined.throwIfAborted();
      this.repository.recordCheck(hostId, host.securityRevision, true, checkedAt);
      return { hostId, success: true, checkedAt };
    } catch (error) {
      if (combined.aborted) return { hostId, success: false, checkedAt, error: remoteHostFailure(signal?.aborted ? signal.reason :
        new RemoteHostError("connection_timeout", "The connection test timed out.", "connection")) };
      this.repository.recordCheck(hostId, host.securityRevision, false, checkedAt);
      const challenge = this.trust.challenge(hostId);
      return { hostId, success: false, checkedAt, error: remoteHostFailure(error), ...(challenge ? { challenge } : {}) };
    } finally { lease?.release(); }
  }

  revokeHost(hostId: string): void {
    this.pool.revokeHost(hostId);
    for (const [id, record] of this.connections) {
      if (record.hostId !== hostId) continue;
      record.controller.abort(new RemoteHostError("target_changed", "The host's security configuration changed."));
      record.connection?.close(); this.connections.delete(id);
    }
  }

  dispose(): void {
    this.pool.dispose();
    for (const record of this.connections.values()) { record.controller.abort(); record.connection?.close(); }
    this.connections.clear();
  }

  revokeClient(clientId: string): void { this.pool.revokeClient(clientId); }
  revokeSession(clientId: string, sessionId: string): void { this.pool.revokeSession(clientId, sessionId); }
}
