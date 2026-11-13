import { randomUUID } from "node:crypto";
import {
  RemoteHostError, remoteSelectionSchema, remoteMessageBindingSchema, type RemoteSelection, type RemoteCallContext,
} from "@fcode/shared";
import { RemoteHostDatabase } from "./database.js";
import { RemoteHostRepository } from "./hostRepository.js";
import { RemoteSnapshotStore } from "./snapshotStore.js";
import { remoteInputDigest } from "./canonicalInput.js";

export interface RemoteMessageBinding {
  selectionId: string;
  sessionId: string;
  messageId: string;
  submissionId: string;
  ownerId: string;
  workspaceKey: string;
}

export interface BindRemoteSelectionInput {
  requestId: string;
  submissionId: string;
  ownerId: string;
  workspaceKey: string;
  binding: RemoteSelection["binding"];
  targets: Array<{ hostId: string; securityRevision: number; trustRevision: number }>;
  sourceIds: string[];
}

export class RemoteSelectionStore {
  constructor(private readonly database: RemoteHostDatabase, private readonly hosts: RemoteHostRepository,
    private readonly sources: RemoteSnapshotStore) {}

  create(input: BindRemoteSelectionInput): RemoteSelection {
    if (input.ownerId !== this.database.ownerId) throw new RemoteHostError("permission_denied", "The selection belongs to another data root.", "authorization");
    const parsed = remoteSelectionSchema.parse({ ...input, selectionId: randomUUID(), createdAt: Date.now(),
      targets: input.targets.map((target) => {
        const host = this.hosts.get(target.hostId);
        const trust = this.hosts.getTrust(target.hostId);
        if (!host.config.enabled) throw new RemoteHostError("host_disabled", "Disabled hosts cannot be selected.");
        if (host.securityRevision !== target.securityRevision || (trust?.trustRevision ?? 0) !== target.trustRevision) {
          throw new RemoteHostError("target_changed", "Reload the host selection before submitting it.");
        }
        return { ...target, displayName: host.config.name };
      }) });
    if (new Set(parsed.targets.map((target) => target.hostId)).size !== parsed.targets.length ||
      new Set(parsed.sourceIds).size !== parsed.sourceIds.length) throw new RemoteHostError("invalid_request", "Duplicate selection entries are not allowed.");
    return this.database.transaction(() => {
      const previous = this.database.connection.prepare("SELECT document FROM remote_selections WHERE request_id = ?").get(input.requestId);
      if (previous) {
        const stored = remoteSelectionSchema.parse(JSON.parse(String(previous.document)));
        const { selectionId: _id, createdAt: _time, ...priorInput } = stored;
        const { selectionId: _newId, createdAt: _newTime, ...nextInput } = parsed;
        if (remoteInputDigest(priorInput) !== remoteInputDigest(nextInput)) throw new RemoteHostError("idempotency_conflict", "This submission identifier was already used for a different selection.");
        return stored;
      }
      for (const sourceId of parsed.sourceIds) {
        const source = this.sources.assertOwned(sourceId, input);
        if (source.availability !== "ready") throw new RemoteHostError("source_not_found", "Confirm the upload source before submitting it.");
      }
      this.database.connection.prepare("INSERT INTO remote_selections(selection_id, request_id, document) VALUES (?, ?, ?)")
        .run(parsed.selectionId, parsed.requestId, JSON.stringify(parsed));
      return parsed;
    });
  }

  get(selectionId: string): RemoteSelection {
    const row = this.database.connection.prepare("SELECT document FROM remote_selections WHERE selection_id = ?").get(selectionId);
    if (!row) throw new RemoteHostError("selection_required", "Select remote hosts for this message.", "authorization");
    return remoteSelectionSchema.parse(JSON.parse(String(row.document)));
  }

  /** Called only for a registered human submission on the private lifecycle channel. */
  bindMessage(input: RemoteMessageBinding): void {
    input = remoteMessageBindingSchema.parse(input);
    this.database.transaction(() => {
      const selected = this.get(input.selectionId);
      if (selected.ownerId !== input.ownerId || selected.workspaceKey !== input.workspaceKey ||
        selected.submissionId !== input.submissionId || selected.binding.kind === "session" && selected.binding.sessionId !== input.sessionId) {
        throw new RemoteHostError("permission_denied", "The message does not match its remote selection.", "authorization");
      }
      const old = this.database.connection.prepare("SELECT document FROM remote_message_bindings WHERE selection_id = ?").get(input.selectionId);
      if (old) {
        if (remoteInputDigest(JSON.parse(String(old.document))) !== remoteInputDigest(input)) {
          throw new RemoteHostError("permission_denied", "The selection is already bound to another message.", "authorization");
        }
        return;
      }
      for (const sourceId of selected.sourceIds) this.sources.promote(sourceId, {
        ownerId: input.ownerId, workspaceKey: input.workspaceKey, binding: selected.binding, sessionId: input.sessionId,
      });
      this.database.connection.prepare(`INSERT INTO remote_message_bindings(selection_id, session_id, message_id, document)
        VALUES (?, ?, ?, ?)`).run(input.selectionId, input.sessionId, input.messageId, JSON.stringify(input));
    });
  }

  forCall(context: RemoteCallContext): RemoteSelection {
    if (!context.selectionId) throw new RemoteHostError("selection_required", "Select remote hosts for this message.", "authorization");
    const selected = this.get(context.selectionId);
    const row = this.database.connection.prepare("SELECT document FROM remote_message_bindings WHERE selection_id = ?").get(selected.selectionId);
    if (!row) throw new RemoteHostError("selection_required", "This selection is not bound to a live user message.", "authorization");
    const binding = remoteMessageBindingSchema.parse(JSON.parse(String(row.document)));
    if (binding.ownerId !== context.ownerId || binding.workspaceKey !== context.workspaceKey ||
      binding.sessionId !== context.sessionId || binding.messageId !== context.messageId) {
      throw new RemoteHostError("permission_denied", "This call does not own the selected remote hosts.", "authorization");
    }
    for (const target of selected.targets) {
      const host = this.hosts.get(target.hostId);
      if (!host.config.enabled) throw new RemoteHostError("host_disabled", "A selected remote host is disabled.");
      if (host.securityRevision !== target.securityRevision || (this.hosts.getTrust(host.hostId)?.trustRevision ?? 0) !== target.trustRevision) {
        throw new RemoteHostError("target_changed", "A selected host changed. Select it again for a new message.");
      }
    }
    return selected;
  }
}
