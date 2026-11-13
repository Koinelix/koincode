import { randomUUID } from "node:crypto";
import { REMOTE_HOST_LIMITS, RemoteHostError, type RemoteHostChallenge,
  type RemoteHostRecord, type RemoteTrustRecord } from "@fcode/shared";
import { RemoteHostRepository } from "./hostRepository.js";
import { remoteEndpoint } from "./hostCatalog.js";

interface PendingTrust {
  challenge: RemoteHostChallenge;
  key: { publicKey: string; keyType: string; fingerprint: string };
  previousTrustRevision: number;
}

export class RemoteTrustAuthority {
  private readonly pending = new Map<string, PendingTrust>();
  constructor(private readonly repository: RemoteHostRepository, private readonly revokeHost: (hostId: string) => void) {}

  verify(host: RemoteHostRecord, key: PendingTrust["key"]): void {
    const current = this.repository.get(host.hostId);
    if (current.securityRevision !== host.securityRevision || !current.config.enabled) {
      throw new RemoteHostError("target_changed", "The host changed before its identity was verified.", "trust");
    }
    const trust = this.repository.getTrust(host.hostId);
    if (trust?.endpoint === remoteEndpoint(host.config) && trust.publicKey === key.publicKey && trust.keyType === key.keyType) return;
    this.expire();
    const challenge: RemoteHostChallenge = {
      challengeId: randomUUID(), hostId: host.hostId, securityRevision: host.securityRevision,
      endpoint: remoteEndpoint(host.config), fingerprint: key.fingerprint, keyType: key.keyType,
      expiresAt: Date.now() + REMOTE_HOST_LIMITS.challengeMs,
    };
    this.pending.set(host.hostId, { challenge, key, previousTrustRevision: trust?.trustRevision ?? 0 });
    throw new RemoteHostError(trust ? "host_key_changed" : "host_key_unknown",
      trust ? "The server identity changed. Verify and reset its trust explicitly." : "Verify this server's fingerprint before authentication.", "trust");
  }

  challenge(hostId: string): RemoteHostChallenge | undefined {
    this.expire();
    return this.pending.get(hostId)?.challenge;
  }

  /** Only the Main-authenticated management route may call this method. */
  accept(challengeId: string, action: "trust_initial" | "replace_changed_key"): RemoteTrustRecord {
    this.expire();
    const entry = [...this.pending.values()].find((value) => value.challenge.challengeId === challengeId);
    if (!entry) throw new RemoteHostError("challenge_expired", "The host identity challenge expired. Test the connection again.", "trust");
    const { challenge, key, previousTrustRevision } = entry;
    this.pending.delete(challenge.hostId);
    if (previousTrustRevision > 0 && action !== "replace_changed_key") {
      throw new RemoteHostError("host_key_changed", "Replacing a trusted server identity requires an explicit reset.", "trust");
    }
    if (previousTrustRevision === 0 && action !== "trust_initial") {
      throw new RemoteHostError("invalid_request", "Use the initial host identity confirmation.", "trust");
    }
    const trust: RemoteTrustRecord = { hostId: challenge.hostId, endpoint: challenge.endpoint,
      publicKey: key.publicKey, keyType: key.keyType, fingerprint: key.fingerprint,
      trustRevision: previousTrustRevision + 1, acceptedAt: Date.now() };
    this.repository.acceptTrust(trust, challenge.securityRevision);
    this.revokeHost(challenge.hostId);
    return trust;
  }

  forget(hostId: string): void { this.pending.delete(hostId); }
  private expire(): void {
    for (const [hostId, record] of this.pending) if (record.challenge.expiresAt <= Date.now()) this.pending.delete(hostId);
  }
}
