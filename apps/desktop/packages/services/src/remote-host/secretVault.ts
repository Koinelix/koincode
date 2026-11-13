import {
  RemoteHostError, remoteSecretMaterialSchema,
  type RemoteHostConfig, type RemoteHostRecord, type RemoteHostSave, type RemoteSecretMaterial,
} from "@fcode/shared";
import type { ProtectedRemoteSecret } from "./hostRepository.js";

export interface RemoteSecretEnvelope {
  formatVersion: 1;
  hostId: string;
  authType: RemoteHostConfig["authType"];
  credentialVersion: number;
  material: RemoteSecretMaterial;
}

/** Only Main may implement the system-protected seal/open operations. */
export interface RemoteSystemSecretPort {
  getStatus(): Promise<{ available: boolean; backend: string; reason?: string }>;
  seal(envelope: RemoteSecretEnvelope): Promise<string>;
  open(ciphertext: string): Promise<RemoteSecretEnvelope>;
}

export interface RemoteSecretPreparation {
  credentialVersion: number;
  protectedSecret: ProtectedRemoteSecret | null | undefined;
  commit(): void;
}

function verifyMaterial(config: RemoteHostConfig, material: RemoteSecretMaterial): void {
  remoteSecretMaterialSchema.parse(material);
  if (config.authType === "password" && !material.password) {
    throw new RemoteHostError("credential_missing", "Enter a password for password authentication.", "authentication");
  }
  if ((config.authType !== "password" && material.password) || (config.authType !== "private_key" && material.passphrase)) {
    throw new RemoteHostError("invalid_request", "The credential does not match the selected authentication method.", "authentication");
  }
}

export class RemoteSecretVault {
  private readonly session = new Map<string, RemoteSecretEnvelope>();
  constructor(private readonly system: RemoteSystemSecretPort) {}

  async prepare(
    hostId: string,
    config: RemoteHostConfig,
    update: RemoteHostSave["secret"],
    previous: RemoteHostRecord | null,
  ): Promise<RemoteSecretPreparation> {
    const version = previous?.credentialVersion ?? 0;
    const changedDomain = previous !== null && previous.config.authType !== config.authType;
    if (update.intent === "keep" && previous && !changedDomain) {
      if (config.secretPersistence !== previous.config.secretPersistence) {
        throw new RemoteHostError("credential_missing", "Re-enter the credential when changing its persistence policy.", "authentication");
      }
      return { credentialVersion: version, protectedSecret: undefined, commit() {} };
    }
    const material: RemoteSecretMaterial = update.intent === "replace" ? update.material : {};
    if (update.intent === "replace") verifyMaterial(config, material);
    const nextVersion = version + 1;
    if (update.intent !== "replace" || config.authType === "ssh_agent") {
      return { credentialVersion: nextVersion, protectedSecret: null, commit: () => { this.session.delete(hostId); } };
    }
    const envelope: RemoteSecretEnvelope = {
      formatVersion: 1, hostId, authType: config.authType, credentialVersion: nextVersion,
      material: { ...material },
    };
    if (config.secretPersistence === "session") {
      return { credentialVersion: nextVersion, protectedSecret: null, commit: () => { this.session.set(hostId, envelope); } };
    }
    const status = await this.system.getStatus();
    if (!status.available || status.backend === "basic_text") {
      throw new RemoteHostError("secure_store_unavailable", "System-protected storage is unavailable. Use a session credential.", "storage");
    }
    // Encryption happens before the database transaction; the previous reference is unchanged on failure.
    const encryptedPayload = await this.system.seal(envelope);
    if (!encryptedPayload) throw new RemoteHostError("secure_store_unavailable", "System protection did not return a credential.", "storage");
    return {
      credentialVersion: nextVersion,
      protectedSecret: { credentialVersion: nextVersion, encryptedPayload },
      commit: () => { this.session.delete(hostId); },
    };
  }

  state(host: RemoteHostRecord, protectedSecret: ProtectedRemoteSecret | null): "available" | "session_only" | "missing" {
    if (!host.credentialRequired) return "available";
    const session = this.session.get(host.hostId);
    if (session?.credentialVersion === host.credentialVersion && session.authType === host.config.authType) return "session_only";
    if (protectedSecret?.credentialVersion === host.credentialVersion) return "available";
    return "missing";
  }

  /** Internal adapter entry: the coordinator must already have verified trust and authorization. */
  async get(host: RemoteHostRecord, protectedSecret: ProtectedRemoteSecret | null): Promise<RemoteSecretMaterial> {
    if (host.config.authType === "ssh_agent") return {};
    let envelope = this.session.get(host.hostId);
    if (!envelope && protectedSecret) envelope = await this.system.open(protectedSecret.encryptedPayload);
    if (!envelope) {
      if (!host.credentialRequired) return {};
      throw new RemoteHostError("credential_missing", "Re-enter this host's credential.", "authentication");
    }
    if (envelope.formatVersion !== 1 || envelope.hostId !== host.hostId || envelope.authType !== host.config.authType ||
      envelope.credentialVersion !== host.credentialVersion) {
      throw new RemoteHostError("credential_corrupt", "The protected credential does not belong to this host and version.", "storage");
    }
    verifyMaterial(host.config, envelope.material);
    return { ...envelope.material };
  }

  forget(hostId: string): void { this.session.delete(hostId); }
  dispose(): void { this.session.clear(); }
}
