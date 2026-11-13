import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { lstat, access } from "node:fs/promises";
import { constants } from "node:fs";
import {
  REMOTE_HOST_LIMITS, RemoteHostError, remoteHostSaveSchema,
  type RemoteHostConfig, type RemoteHostRecord, type RemoteHostSummary, type RemoteHostPage,
} from "@fcode/shared";
import { RemoteHostRepository } from "./hostRepository.js";
import { RemoteSecretVault } from "./secretVault.js";

function securityFields(config: RemoteHostConfig): string {
  const { name: _name, group: _group, tags: _tags, ...security } = config;
  return JSON.stringify(security);
}

export { remoteEndpoint } from "@fcode/shared";
import { remoteEndpoint } from "@fcode/shared";

export class RemoteHostCatalog {
  private readonly requestKey = randomBytes(32);
  private readonly requests = new Map<string, { digest: string; hostId: string }>();
  private queue = Promise.resolve();
  constructor(
    readonly repository: RemoteHostRepository,
    private readonly vault: RemoteSecretVault,
    private readonly revokeHost: (hostId: string) => void,
  ) {}

  summary(host: RemoteHostRecord): RemoteHostSummary {
    const trust = this.repository.getTrust(host.hostId);
    return { ...host,
      credentialState: this.vault.state(host, this.repository.getProtectedSecret(host.hostId)),
      trustState: !trust ? "unknown" : trust.endpoint === remoteEndpoint(host.config) ? "trusted" : "changed",
      trustRevision: trust?.trustRevision ?? 0 };
  }

  list(input: { query?: string; group?: string; enabled?: boolean; cursor?: string; limit?: number } = {}): RemoteHostPage {
    const query = input.query?.trim().toLocaleLowerCase() ?? "";
    const limit = Math.min(Math.max(input.limit ?? REMOTE_HOST_LIMITS.pageSize, 1), REMOTE_HOST_LIMITS.maxPageSize);
    const catalogRevision = this.repository.catalogRevision();
    const filterDigest = createHash("sha256").update(JSON.stringify([query, input.group, input.enabled])).digest("hex");
    let offset = 0;
    if (input.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
        if (cursor.revision !== catalogRevision || cursor.filter !== filterDigest || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error("Invalid cursor");
        offset = cursor.offset;
      } catch { throw new RemoteHostError("revision_conflict", "The host list changed. Reload its first page."); }
    }
    const hosts = this.repository.list().filter(({ config }) =>
      (input.enabled === undefined || config.enabled === input.enabled) &&
      (input.group === undefined || config.group === input.group) &&
      (!query || [config.name, config.host, config.username, config.group, ...config.tags].some((value) => value.toLocaleLowerCase().includes(query))));
    const items = hosts.slice(offset, offset + limit).map((host) => this.summary(host));
    const nextCursor = offset + items.length < hosts.length
      ? Buffer.from(JSON.stringify({ revision: catalogRevision, filter: filterDigest, offset: offset + items.length })).toString("base64url") : undefined;
    return { items, total: hosts.length, catalogRevision, ...(nextCursor ? { nextCursor } : {}) };
  }

  save(raw: unknown): Promise<RemoteHostSummary> {
    const result = this.queue.then(() => this.saveSerialized(raw));
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  private async saveSerialized(raw: unknown): Promise<RemoteHostSummary> {
    const input = remoteHostSaveSchema.parse(raw);
    const digest = createHmac("sha256", this.requestKey).update(JSON.stringify(input)).digest("hex");
    const oldRequest = this.requests.get(input.requestId);
    if (oldRequest) {
      if (oldRequest.digest !== digest) throw new RemoteHostError("idempotency_conflict", "This request identifier was already used for different input.");
      return this.summary(this.repository.get(oldRequest.hostId));
    }
    const previous = input.hostId ? this.repository.get(input.hostId) : null;
    if (!previous && this.repository.list().length >= REMOTE_HOST_LIMITS.hostCount) throw new RemoteHostError("transfer_limit", "The host catalog reached its profile limit.");
    if (input.config.authType === "private_key") {
      try {
        const info = await lstat(input.config.privateKeyPath!);
        if (!info.isFile() || info.size > REMOTE_HOST_LIMITS.privateKeyBytes) throw new Error("Invalid key file");
        await access(input.config.privateKeyPath!, constants.R_OK);
      } catch { throw new RemoteHostError("credential_missing", "Select a readable regular private key file within the size limit.", "authentication"); }
    }
    if (previous && input.expectedRevision !== previous.revision) {
      throw new RemoteHostError("revision_conflict", "The host was changed in another window. Reload before saving.");
    }
    if (!previous && input.expectedRevision !== undefined) throw new RemoteHostError("invalid_request", "A new host cannot have an existing revision.");
    const hostId = previous?.hostId ?? randomUUID();
    const prepared = await this.vault.prepare(hostId, input.config, input.secret, previous);
    const securityChanged = !previous || securityFields(input.config) !== securityFields(previous.config) ||
      prepared.credentialVersion !== previous.credentialVersion;
    const now = Date.now();
    const record: RemoteHostRecord = {
      hostId, config: input.config, revision: (previous?.revision ?? 0) + 1,
      securityRevision: (previous?.securityRevision ?? 0) + (securityChanged ? 1 : 0),
      credentialVersion: prepared.credentialVersion,
      credentialRequired: input.config.authType === "password" || input.config.authType === "private_key" &&
        (input.secret.intent === "replace" ? Boolean(input.secret.material.passphrase) :
          input.secret.intent === "keep" && previous?.config.authType === "private_key" && Boolean(previous.credentialRequired)),
      createdAt: previous?.createdAt ?? now, updatedAt: now,
      ...(previous?.lastCheckedAt ? { lastCheckedAt: previous.lastCheckedAt, lastCheckResult: previous.lastCheckResult } : {}),
    };
    this.repository.save(record, previous?.revision ?? null, prepared.protectedSecret);
    prepared.commit();
    if (securityChanged) this.revokeHost(hostId);
    this.requests.set(input.requestId, { digest, hostId });
    return this.summary(record);
  }

  remove(hostId: string, expectedRevision: number): void {
    this.repository.remove(hostId, expectedRevision);
    this.vault.forget(hostId);
    this.revokeHost(hostId);
  }

  dispose(): void { this.requests.clear(); this.requestKey.fill(0); }
}
