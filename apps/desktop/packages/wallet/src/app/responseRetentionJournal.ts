import { randomUUID } from "node:crypto";
import type { GuardedWalletState } from "./guardedState.js";
import type { WalletState } from "./state.js";
import type { ResponseRetentionEvidence, ResponseRetentionRecord } from "../domain/responseRetention.js";
import { requireWallet } from "../domain/errors.js";

/** Internal persistent journal. Storage IO and access authorization belong to its trusted owner. */
export class ResponseRetentionJournal {
  constructor(private readonly owner: GuardedWalletState) {}
  async begin(requestId: string, phase: "initial" | "paid", createdAt: number, expiresAt: number) {
    return this.owner.mutate(state => {
      const request = state.transport?.requests.find(r => r.requestId === requestId);
      requireWallet(request && !request.canceled && request.epoch === state.managementEpoch &&
        state.transport!.epoch === state.managementEpoch && request.expiresAt > createdAt,
      "RESPONSE_RETENTION_UNAVAILABLE", "A current request is required to retain a response.");
      requireWallet((phase === "initial" || phase === "paid") &&
        Number.isSafeInteger(createdAt) && Number.isSafeInteger(expiresAt) &&
        createdAt >= request.createdAt && expiresAt > createdAt &&
        expiresAt <= request.expiresAt && expiresAt - createdAt <= 86400000,
      "RESPONSE_RETENTION_UNAVAILABLE", "The retention phase and bounded lifetime are invalid.");
      const existing = state.transport!.retentions ?? [];
      requireWallet(existing.length < 100000 && !existing.some(r => r.requestId === requestId &&
        r.phase === phase && (r.state === "writing" || r.state === "ready")),
      "RESPONSE_RETENTION_BUSY", "The response phase or retention inventory is occupied.");
      const record: ResponseRetentionRecord = { version: 1, retentionId: randomUUID(), requestId,
        ownerId: request.ownerId, clientId: request.clientId, epoch: request.epoch, phase,
        rawRef: randomUUID(), contextRef: randomUUID(), createdAt, expiresAt, state: "writing" };
      (state.transport!.retentions ??= []).push(record);
      return record;
    });
  }
  async markReady(id: string, evidence: ResponseRetentionEvidence) {
    const captured = structuredClone(evidence);
    return this.owner.mutate(state => {
      const r = this.find(state, id);
      requireWallet(r.state === "writing" && r.epoch === state.managementEpoch,
        "RESPONSE_RETENTION_UNAVAILABLE", "A current write intent is required to retain completion.");
      Object.assign(r, captured, { state: "ready" });
      return r;
    });
  }
  ready(id: string, now: number): ResponseRetentionRecord {
    return this.available(id, now, "ready");
  }
  writing(id: string, now: number): ResponseRetentionRecord {
    return this.available(id, now, "writing");
  }
  private available(id: string, now: number, phase: "writing" | "ready"): ResponseRetentionRecord {
    requireWallet(this.owner.continuityValid(), "RESPONSE_RETENTION_UNAVAILABLE",
      "Protected response continuity is unavailable.");
    const state = this.owner.snapshot(), r = this.find(state, id);
    const request = state.transport!.requests.find(value => value.requestId === r.requestId);
    requireWallet(r.state === phase && r.epoch === state.managementEpoch && request &&
      !request.canceled && Number.isSafeInteger(now) && now >= r.createdAt && now < r.expiresAt,
    "RESPONSE_RETENTION_UNAVAILABLE", "The retained response is unavailable or expired.");
    return r;
  }
  async beginDelete(id: string) {
    return this.owner.mutate(state => {
      const r = this.find(state, id);
      if (r.state !== "deleted") r.state = "deleting";
      return r;
    });
  }
  /** Call only after the cleanup owner has confirmed key and ciphertext removal. */
  async markDeleted(id: string) {
    return this.owner.mutate(state => {
      const r = this.find(state, id);
      requireWallet(r.state === "deleting" || r.state === "deleted", "RESPONSE_RETENTION_UNAVAILABLE",
        "A durable deletion intent is required before completion.");
      r.state = "deleted";
      return r;
    });
  }
  private find(state: WalletState, id: string): ResponseRetentionRecord {
    const r = state.transport?.retentions?.find(value => value.retentionId === id);
    requireWallet(r && r.ownerId === state.ownerId, "RESPONSE_RETENTION_UNAVAILABLE",
      "The response retention record is unavailable.");
    return r;
  }
}
