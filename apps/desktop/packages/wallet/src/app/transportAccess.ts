import { requirePeer, type PeerIdentityProof } from "./peerIdentity.js";
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { requireWallet } from "../domain/errors.js";
import type { CredentialRecord } from "../domain/requestModel.js";
import type { ProtectedStore } from "./ports.js";
import type { RuntimeContext } from "./runtimeContext.js";
import { audit } from "./runtimeContext.js";
import { transport } from "./transportState.js";
import { credentialReferences } from "./credentialMetadata.js";
import type { ClientHandle } from "./sessions.js";
export const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");
export class WalletConnections {
  constructor(private readonly ctx: RuntimeContext) {}
  async rotate(clientId: string): Promise<string> {
    this.ctx.sessions.invalidateClient(clientId);
    const token = randomBytes(32).toString("base64url");
    await this.ctx.controls.run(() =>
      this.ctx.state.mutate((state) => {
        const client = state.clients.find((c) => c.clientId === clientId && c.active);
        requireWallet(client, "CLIENT_NOT_FOUND", "The client is not registered.");
        client.generation++;
        state.sessions = state.sessions.filter((s) => s.clientId !== clientId);
        const t = transport(state),
          record = {
            clientId,
            generation: client.generation,
            tokenDigest: tokenDigest(token),
            active: true,
            epoch: state.managementEpoch,
          };
        const old = t.tokens.find((x) => x.clientId === clientId);
        if (old) Object.assign(old, record);
        else t.tokens.push(record);
        audit(state, "CLIENT_TOKEN_ROTATED", null, { clientId });
      }),
    );
    this.ctx.sessions.allowClient(clientId);
    return token;
  }
  checkPeer(handle: ClientHandle, proof?: PeerIdentityProof): void {
    const state = this.ctx.state.snapshot(),
      context = this.ctx.sessions.resolve(handle, state),
      client = state.clients.find((x) => x.clientId === context.clientId)!;
    if (!client.peerIdentityKey) return;
    const peer = proof ? requirePeer(proof, handle) : null;
    requireWallet(
      peer?.valid && peer.identityKey === client.peerIdentityKey,
      "CLIENT_REGISTRATION_REQUIRED",
      "The registered code identity changed or cannot be verified. Register a new client.",
    );
  }
  async bindPeerIdentity(handle: ClientHandle, proof: PeerIdentityProof) {
    const peer = requirePeer(proof, handle);
    requireWallet(
      peer.valid && peer.identityKey,
      "CLIENT_IDENTITY_UNAVAILABLE",
      "A valid kernel-bound code identity is required for registration binding.",
    );
    await this.ctx.controls.run(() =>
      this.ctx.state.mutate((state) => {
        const context = this.ctx.sessions.resolve(handle, state),
          client = state.clients.find((x) => x.clientId === context.clientId)!;
        requireWallet(
          !client.peerIdentityKey || client.peerIdentityKey === peer.identityKey,
          "CLIENT_REGISTRATION_REQUIRED",
          "A different code identity requires a new client registration.",
        );
        if (!client.peerIdentityKey) {
          this.ctx.sessions.invalidateOthers(client.clientId, handle);
          state.sessions = state.sessions.filter(
            (session) =>
              session.clientId !== client.clientId ||
              (session.sessionId === context.sessionId &&
                session.generation === context.generation),
          );
        }
        client.peerIdentityKey = peer.identityKey!;
        audit(state, "CLIENT_CODE_IDENTITY_BOUND", null, { clientId: client.clientId });
      }),
    );
    return peer;
  }
  async authenticate(clientId: string, token: string): Promise<ClientHandle> {
    requireWallet(
      typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token),
      "CLIENT_AUTHENTICATION_REQUIRED",
      "A valid client credential is required.",
    );
    const state = this.ctx.state.snapshot(),
      t = transport(state),
      record = t.tokens.find(
        (x) => x.clientId === clientId && x.active && x.epoch === state.managementEpoch,
      ),
      client = state.clients.find((x) => x.clientId === clientId && x.active);
    requireWallet(
      record &&
        client &&
        record.generation === client.generation &&
        timingSafeEqual(
          Buffer.from(record.tokenDigest, "hex"),
          Buffer.from(tokenDigest(token), "hex"),
        ),
      "CLIENT_AUTHENTICATION_REQUIRED",
      "Client authentication failed.",
    );
    const handle = await this.ctx.sessions.connect(clientId);
    const latest = this.ctx.state.snapshot();
    if (
      latest.transport?.tokens.find((x) => x.clientId === clientId)?.tokenDigest !==
      record.tokenDigest
    ) {
      await this.ctx.sessions.disconnect(handle);
      requireWallet(
        false,
        "CLIENT_AUTHENTICATION_REQUIRED",
        "The client credential changed during connection.",
      );
    }
    return handle;
  }
}
export class WalletCredentials {
  constructor(
    private readonly ctx: RuntimeContext,
    private readonly protection: ProtectedStore,
  ) {}
  list(handle: ClientHandle) {
    const state = this.ctx.state.snapshot();
    const client = this.ctx.sessions.resolve(handle, state);
    return credentialReferences(state, client.clientId);
  }
  async save(input: {
    ref?: string;
    clientIds: string[];
    origin: string;
    path: string;
    headerName: "authorization" | "x-api-key";
    value: string;
  }): Promise<string> {
    requireWallet(
      input.value.length > 0 &&
        Buffer.byteLength(input.value) <= 16384 &&
        !/[\r\n]/.test(input.value) &&
        !input.value.includes("\0"),
      "INVALID_CREDENTIAL",
      "The credential value is invalid.",
    );
    const url = new URL(input.origin);
    requireWallet(
      url.origin === input.origin &&
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        /^\/(?!\/)/.test(input.path) &&
        !/[?#]/.test(input.path) &&
        ["authorization", "x-api-key"].includes(input.headerName) &&
        input.clientIds.length > 0 &&
        input.clientIds.length <= 128,
      "INVALID_CREDENTIAL",
      "Credential scope is invalid.",
    );
    const frozen = structuredClone(input),
      ref = frozen.ref ?? randomUUID(),
      secretRef = "http-credential:" + randomUUID();
    await this.ctx.controls.run(async () => {
      const bytes = Buffer.from(frozen.value);
      try {
        await this.protection.put(secretRef, bytes);
      } finally {
        bytes.fill(0);
      }
      await this.ctx.state.mutate((state) => {
        requireWallet(
          frozen.clientIds.every((id) => state.clients.some((c) => c.clientId === id && c.active)),
          "CLIENT_NOT_FOUND",
          "All credential recipients must be registered.",
        );
        const t = transport(state),
          old = t.credentials.find((x) => x.ref === ref);
        const record: CredentialRecord = {
          ref,
          ownerId: state.ownerId,
          clientIds: [...new Set(frozen.clientIds)],
          origin: frozen.origin,
          path: frozen.path,
          headerName: frozen.headerName,
          secretRef,
          active: true,
          epoch: state.managementEpoch,
          version: (old?.version ?? 0) + 1,
        };
        if (old) Object.assign(old, record);
        else t.credentials.push(record);
        audit(state, "CREDENTIAL_SAVED", null, { ref, version: record.version });
      });
    });
    return ref;
  }
  async revoke(ref: string): Promise<void> {
    await this.ctx.controls.run(() =>
      this.ctx.state.mutate((state) => {
        const record = transport(state).credentials.find((x) => x.ref === ref);
        requireWallet(record, "CREDENTIAL_NOT_FOUND", "The credential is unavailable.");
        record.active = false;
        record.version++;
        audit(state, "CREDENTIAL_REVOKED", null, { ref });
      }),
    );
  }
  metadata(handle: ClientHandle, ref: string, url: string, version?: number): CredentialRecord {
    const state = this.ctx.state.snapshot(),
      context = this.ctx.sessions.resolve(handle, state),
      target = new URL(url);
    const record = transport(state).credentials.find(
      (x) =>
        x.ref === ref &&
        x.active &&
        x.epoch === state.managementEpoch &&
        x.ownerId === context.ownerId &&
        x.clientIds.includes(context.clientId),
    );
    requireWallet(
      record &&
        record.origin === target.origin &&
        (target.pathname === record.path ||
          target.pathname.startsWith(
            record.path.endsWith("/") ? record.path : record.path + "/",
          )) &&
        (version === undefined || record.version === version),
      "CREDENTIAL_NOT_FOUND",
      "The credential is unavailable for this client or target.",
    );
    return structuredClone(record);
  }
  async headers(
    handle: ClientHandle,
    ref: string | null,
    url: string,
    version: number | null,
  ): Promise<Record<string, string>> {
    if (!ref) return {};
    const record = this.metadata(handle, ref, url, version ?? undefined),
      bytes = await this.protection.get(record.secretRef);
    requireWallet(
      bytes && bytes.length > 0 && bytes.length <= 16384,
      "CREDENTIAL_NOT_FOUND",
      "The protected credential is unavailable.",
    );
    try {
      this.metadata(handle, ref, url, record.version);
      return { [record.headerName]: Buffer.from(bytes).toString("utf8") };
    } finally {
      bytes.fill(0);
    }
  }
}
