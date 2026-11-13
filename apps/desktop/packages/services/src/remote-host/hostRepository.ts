import {
  REMOTE_HOST_LIMITS, RemoteHostError, remoteHostRecordSchema, remoteTrustRecordSchema,
  type RemoteHostRecord, type RemoteTrustRecord,
} from "@fcode/shared";
import { RemoteHostDatabase, normalizeRemoteStorageError } from "./database.js";

function decode<T>(document: unknown, parse: (value: unknown) => T): T {
  try {
    if (typeof document !== "string") throw new Error("Missing document");
    return parse(JSON.parse(document));
  } catch {
    throw new RemoteHostError("storage_corrupt", "A stored Remote Host record is invalid.", "storage");
  }
}

export interface ProtectedRemoteSecret {
  credentialVersion: number;
  encryptedPayload: string;
}

export class RemoteHostRepository {
  constructor(private readonly database: RemoteHostDatabase) {}

  list(): RemoteHostRecord[] {
    try {
      return this.database.connection.prepare("SELECT document FROM remote_hosts ORDER BY host_id").all()
        .map((row) => decode(row.document, remoteHostRecordSchema.parse));
    } catch (error) { throw normalizeRemoteStorageError(error); }
  }

  get(hostId: string): RemoteHostRecord {
    const row = this.database.connection.prepare("SELECT document FROM remote_hosts WHERE host_id = ?").get(hostId);
    if (!row) throw new RemoteHostError("host_deleted", "The selected remote host no longer exists.");
    return decode(row.document, remoteHostRecordSchema.parse);
  }

  catalogRevision(): number {
    return Number(this.database.connection.prepare("SELECT value FROM remote_metadata WHERE name = ?").get("catalog_revision")?.value);
  }

  private changeCatalog(): void {
    this.database.connection.prepare("UPDATE remote_metadata SET value = CAST(value AS INTEGER) + 1 WHERE name = ?")
      .run("catalog_revision");
  }

  save(record: RemoteHostRecord, expectedRevision: number | null, secret: ProtectedRemoteSecret | null | undefined): void {
    const parsed = remoteHostRecordSchema.parse(record);
    this.database.transaction(() => {
      const old = this.database.connection.prepare("SELECT revision FROM remote_hosts WHERE host_id = ?").get(record.hostId);
      if ((expectedRevision === null && old) || (expectedRevision !== null && Number(old?.revision) !== expectedRevision)) {
        throw new RemoteHostError("revision_conflict", "The host was changed in another window. Reload it before saving.");
      }
      if (!old && this.list().length >= REMOTE_HOST_LIMITS.hostCount) {
        throw new RemoteHostError("transfer_limit", "The remote host catalog has reached its limit.");
      }
      this.database.connection.prepare(`INSERT INTO remote_hosts(host_id, revision, security_revision, document)
        VALUES (?, ?, ?, ?) ON CONFLICT(host_id) DO UPDATE SET revision=excluded.revision,
        security_revision=excluded.security_revision, document=excluded.document`)
        .run(parsed.hostId, parsed.revision, parsed.securityRevision, JSON.stringify(parsed));
      if (secret === null) {
        this.database.connection.prepare("DELETE FROM remote_secret_records WHERE host_id = ?").run(record.hostId);
      } else if (secret !== undefined) {
        this.database.connection.prepare(`INSERT INTO remote_secret_records(host_id, credential_version, encrypted_payload)
          VALUES (?, ?, ?) ON CONFLICT(host_id) DO UPDATE SET credential_version=excluded.credential_version,
          encrypted_payload=excluded.encrypted_payload`).run(record.hostId, secret.credentialVersion, secret.encryptedPayload);
      }
      this.changeCatalog();
    });
  }

  remove(hostId: string, expectedRevision: number): void {
    this.database.transaction(() => {
      if (this.get(hostId).revision !== expectedRevision) throw new RemoteHostError("revision_conflict", "The host was changed in another window.");
      this.database.connection.prepare("DELETE FROM remote_hosts WHERE host_id = ?").run(hostId);
      this.changeCatalog();
    });
  }

  getProtectedSecret(hostId: string): ProtectedRemoteSecret | null {
    const row = this.database.connection.prepare("SELECT credential_version, encrypted_payload FROM remote_secret_records WHERE host_id = ?").get(hostId);
    return row ? { credentialVersion: Number(row.credential_version), encryptedPayload: String(row.encrypted_payload) } : null;
  }

  getTrust(hostId: string): RemoteTrustRecord | null {
    const row = this.database.connection.prepare("SELECT document FROM remote_host_trust WHERE host_id = ?").get(hostId);
    return row ? decode(row.document, remoteTrustRecordSchema.parse) : null;
  }

  acceptTrust(trust: RemoteTrustRecord, expectedSecurityRevision: number): RemoteHostRecord {
    const parsed = remoteTrustRecordSchema.parse(trust);
    return this.database.transaction(() => {
      const host = this.get(trust.hostId);
      if (host.securityRevision !== expectedSecurityRevision) throw new RemoteHostError("target_changed", "The host changed while its identity was being confirmed.", "trust");
      const old = this.getTrust(trust.hostId);
      if (parsed.trustRevision !== (old?.trustRevision ?? 0) + 1) throw new RemoteHostError("revision_conflict", "The host trust record changed.", "trust");
      this.database.connection.prepare(`INSERT INTO remote_host_trust(host_id, document) VALUES (?, ?)
        ON CONFLICT(host_id) DO UPDATE SET document=excluded.document`).run(parsed.hostId, JSON.stringify(parsed));
      const updated = { ...host, revision: host.revision + 1, securityRevision: host.securityRevision + 1, updatedAt: parsed.acceptedAt };
      this.database.connection.prepare("UPDATE remote_hosts SET revision=?, security_revision=?, document=? WHERE host_id=?")
        .run(updated.revision, updated.securityRevision, JSON.stringify(updated), updated.hostId);
      this.changeCatalog();
      return updated;
    });
  }

  recordCheck(hostId: string, securityRevision: number, success: boolean, checkedAt: number): void {
    this.database.transaction(() => {
      const host = this.get(hostId);
      if (host.securityRevision !== securityRevision) return;
      this.database.connection.prepare("UPDATE remote_hosts SET document=? WHERE host_id=?")
        .run(JSON.stringify({ ...host, lastCheckedAt: checkedAt, lastCheckResult: success ? "success" : "failed" }), hostId);
    });
  }
}
