import { HTTP_STAGE_TIMEOUT_MS, httpStageTimeout } from "../domain/requestTiming.js";
import { randomUUID } from "node:crypto";
import type { FrozenRequest, RequestRecord, StoredQuote } from "../domain/requestModel.js";
import { validateInput, jsonBody, headerName } from "../domain/requestValidation.js";
import { requireWallet } from "../domain/errors.js";
import type { RuntimeContext } from "./runtimeContext.js";
import { audit } from "./runtimeContext.js";
import type { RequestEnvironment } from "./requestPorts.js";
import { requestDigest } from "./requestFacts.js";
import type { WalletCredentials } from "./transportAccess.js";
import { transport, operationHistory, ownedOperation } from "./transportState.js";
import type { ClientHandle } from "./sessions.js";
export class RequestStore {
  constructor(
    readonly ctx: RuntimeContext,
    readonly env: RequestEnvironment,
    readonly credentials: WalletCredentials,
  ) {}
  owned(handle: ClientHandle, id: string): RequestRecord {
    requireWallet(
      this.ctx.state.continuityValid(),
      "OPERATION_HISTORY_INCOMPLETE",
      "Operation history continuity is unavailable.",
    );
    const state = this.ctx.state.snapshot(),
      context = this.ctx.sessions.resolve(handle, state),
      t = transport(state);
    const record = t.requests.find(
      (x) => x.requestId === id && x.clientId === context.clientId && x.ownerId === context.ownerId,
    );
    requireWallet(record, "REQUEST_NOT_FOUND", "The request is unavailable.");
    return record;
  }
  async update(id: string, change: (r: RequestRecord) => void): Promise<RequestRecord> {
    return this.ctx.state.mutate((state) => {
      const r = transport(state).requests.find((x) => x.requestId === id);
      requireWallet(r, "REQUEST_NOT_FOUND", "The request is unavailable.");
      change(r);
      return r;
    });
  }
  assertResponseReadable(handle: ClientHandle, id: string): RequestRecord {
    const record = this.owned(handle, id);
    requireWallet(
      record.responseRef && this.env.wall() < record.expiresAt,
      "RESPONSE_UNAVAILABLE",
      "The complete response is unavailable or expired.",
    );
    return record;
  }
  async frozen(record: RequestRecord): Promise<FrozenRequest> {
    requireWallet(
      this.env.wall() < record.expiresAt,
      "REQUEST_CONTEXT_UNAVAILABLE",
      "The frozen request has expired; its tombstone is retained.",
    );
    const bytes = await this.env.blobs.get(record.frozenRef);
    try {
      const result = JSON.parse(Buffer.from(bytes).toString("utf8"));
      requireWallet(
        requestDigest(result) === record.frozenDigest,
        "REQUEST_CONTEXT_UNAVAILABLE",
        "The frozen request digest differs.",
      );
      httpStageTimeout(result);
      return result;
    } finally {
      bytes.fill(0);
    }
  }
  async quote(record: RequestRecord): Promise<StoredQuote> {
    requireWallet(record.quoteRef, "X402_INVALID_CHALLENGE", "No frozen challenge is available.");
    const bytes = await this.env.blobs.get(record.quoteRef);
    try {
      return JSON.parse(Buffer.from(bytes).toString("utf8"));
    } finally {
      bytes.fill(0);
    }
  }
  async putJson(
    value: unknown,
    sink: Pick<RequestEnvironment["blobs"], "put"> = this.env.blobs,
  ): Promise<string> {
    const bytes = Buffer.from(JSON.stringify(value));
    try {
      return await sink.put(bytes);
    } finally {
      bytes.fill(0);
    }
  }
  async prepare(
    handle: ClientHandle,
    inputValue: unknown,
    operationId: string,
  ): Promise<{ record: RequestRecord; created: boolean }> {
    requireWallet(
      typeof operationId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          operationId,
        ),
      "OPERATION_CONTEXT_REQUIRED",
      "A durable trusted operation UUID is required.",
    );
    const input = validateInput(inputValue),
      inputDigest = requestDigest(input),
      state = this.ctx.state.snapshot(),
      context = this.ctx.sessions.resolve(handle, state);
    const old = ownedOperation(state, context, operationId);
    if (old) {
      requireWallet(
        old.inputDigest === inputDigest,
        "REQUEST_CONFLICT",
        "The operation already has different input.",
      );
      return { record: old, created: false };
    }
    let replayPolicyDigest: string | undefined;
    let parent: RequestRecord | null = null,
      frozen: FrozenRequest;
    if (input.requestContextRef) {
      parent = this.owned(handle, input.requestContextRef);
      frozen = await this.frozen(parent);
      requireWallet(!frozen.hostPayment, "RECOVERY_NOT_SUPPORTED",
        "A payment-only context cannot authorize wallet-owned merchant HTTP.");
      frozen = { ...frozen, paymentMode: "never" };
      const approved = this.replayPolicy(frozen);
      replayPolicyDigest = approved ? requestDigest(approved) : undefined;
      requireWallet(
        approved &&
          approved.expiresAt > this.env.wall() &&
          (input.requestContextAction === "refresh_quote"
            ? approved.safeReplay
            : approved.recoveryHeaders),
        "RECOVERY_NOT_SUPPORTED",
        "A trusted merchant replay or recovery contract is required.",
      );
      if (input.requestContextAction === "refresh_quote")
        requireWallet(
          Object.keys(input.headers ?? {}).length === 0,
          "INVALID_HEADER",
          "Quote refresh cannot add recovery headers.",
        );
      for (const [name, value] of Object.entries(input.headers ?? {}))
        requireWallet(
          approved.recoveryHeaders?.[name.toLowerCase()] === value,
          "INVALID_HEADER",
          "The recovery header is not approved.",
        );
      if (input.requestContextAction !== "refresh_quote")
        frozen.headers = { ...frozen.headers, ...approved.recoveryHeaders };
    } else {
      let url: URL;
      try {
        url = new URL(input.url!);
      } catch {
        requireWallet(false, "INVALID_URL", "A valid absolute URL is required.");
      }
      requireWallet(
        url!.href === input.url && !url!.username && !url!.password && !url!.hash,
        "INVALID_URL",
        "The URL must be canonical and contain no credentials or fragment.",
      );
      requireWallet(
        !/%(?:2f|5c|25|00)/i.test(url!.pathname),
        "INVALID_URL",
        "Ambiguous encoded path separators are not allowed for scoped transport.",
      );
      const headers = Object.fromEntries(
        Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      );
      let body = Object.hasOwn(input, "bodyJson") ? jsonBody(input.bodyJson) : null;
      if (input.bodyRef) {
        const bodyRecord = transport(state).bodies.find(
          (x) =>
            x.ref === input.bodyRef &&
            x.ownerId === context.ownerId &&
            x.clientId === context.clientId &&
            x.expiresAt > this.env.wall(),
        );
        requireWallet(bodyRecord, "BODY_NOT_FOUND", "The request body reference is unavailable.");
        const bytes = await this.env.blobs.get(bodyRecord.blobRef);
        try {
          body = jsonBody(JSON.parse(Buffer.from(bytes).toString("utf8")));
        } finally {
          bytes.fill(0);
        }
      }
      if (body !== null) headers["content-type"] = "application/json";
      const businessKey = input.idempotency ? randomUUID() : null;
      if (input.idempotency) headers[input.idempotency.headerName.toLowerCase()] = businessKey!;
      const credential = input.credentialRef
        ? this.credentials.metadata(handle, input.credentialRef, url!.href)
        : null;
      frozen = {
        httpTimeoutMs: HTTP_STAGE_TIMEOUT_MS,
        url: url!.href,
        method: input.method!,
        headers,
        body,
        credentialRef: credential?.ref ?? null,
        credentialVersion: credential?.version ?? null,
        businessKey,
        paymentMode: input.paymentMode ?? "policy",
      };
    }
    const frozenRef = await this.putJson(frozen),
      frozenDigest = requestDigest(frozen),
      parentId = parent?.requestId ?? null;
    const result = await this.ctx.state.mutate((next) => {
      const latest = this.ctx.sessions.resolve(handle, next),
        t = operationHistory(next, context.clientId);
      requireWallet(
        latest.generation === context.generation,
        "CLIENT_AUTHENTICATION_REQUIRED",
        "The client generation changed.",
      );
      const duplicate = t.requests.find(
        (x) =>
          x.ownerId === latest.ownerId &&
          x.clientId === latest.clientId &&
          x.operationId === operationId,
      );
      if (duplicate) {
        requireWallet(
          duplicate.inputDigest === inputDigest,
          "REQUEST_CONFLICT",
          "The operation already has different input.",
        );
        return { record: duplicate, created: false };
      }
      const now = this.env.wall(),
        record: RequestRecord = {
          requestId: randomUUID(),
          operationId,
          ownerId: latest.ownerId,
          clientId: latest.clientId,
          sessionId: latest.sessionId,
          generation: latest.generation,
          epoch: next.managementEpoch,
          inputDigest,
          frozenRef,
          frozenDigest,
          createdAt: now,
          expiresAt: now + 7 * 86400000,
          parentRequestId: parentId,
          ...(replayPolicyDigest ? { replayPolicyDigest } : {}),
          action: parentId ? (input.requestContextAction ?? "recover") : "request",
          transportStatus: "prepared",
          paymentStatus: "not_required",
          intentIds: [],
          replacementCount: 0,
          canceled: false,
        };
      t.requests.push(record);
      audit(next, "HTTP_PREPARED", null, { requestId: record.requestId });
      return { record, created: true };
    });
    return result;
  }
  replayPolicy(frozen: FrozenRequest) {
    const url = new URL(frozen.url);
    return transport(this.ctx.state.snapshot()).replayPolicies?.find(
      (p) => p.origin === url.origin && p.path === url.pathname && p.method === frozen.method,
    );
  }
  async approveReplay(policy: import("../domain/requestModel.js").ReplayPolicy): Promise<void> {
    const frozen = structuredClone(policy),
      url = new URL(frozen.origin);
    requireWallet(
      url.origin === frozen.origin &&
        frozen.path.startsWith("/") &&
        ["GET", "POST"].includes(frozen.method) &&
        Number.isSafeInteger(frozen.expiresAt) &&
        frozen.expiresAt > this.env.wall() &&
        frozen.expiresAt <= this.env.wall() + 7 * 86400000 &&
        typeof frozen.safeReplay === "boolean",
      "INVALID_REQUEST",
      "The trusted replay contract is invalid or unbounded.",
    );
    for (const [name, value] of Object.entries(frozen.recoveryHeaders ?? {})) {
      headerName(name);
      requireWallet(
        typeof value === "string" && value.length <= 2048 && !/[\r\n]/.test(value),
        "INVALID_HEADER",
        "The approved recovery header is invalid.",
      );
    }
    if (frozen.recoveryHeaders)
      frozen.recoveryHeaders = Object.fromEntries(
        Object.entries(frozen.recoveryHeaders).map(([name, value]) => [name.toLowerCase(), value]),
      );
    await this.ctx.controls.run(() =>
      this.ctx.state.mutate((state) => {
        const t = transport(state);
        t.replayPolicies ??= [];
        const old = t.replayPolicies.find(
          (p) => p.origin === frozen.origin && p.path === frozen.path && p.method === frozen.method,
        );
        if (old) {
          delete old.recoveryHeaders;
          Object.assign(old, frozen);
        } else t.replayPolicies.push(frozen);
        audit(state, "HTTP_REPLAY_CONTRACT_APPROVED", null);
      }),
    );
  }
  async registerBody(handle: ClientHandle, value: unknown): Promise<string> {
    const body = jsonBody(value),
      context = this.ctx.sessions.resolve(handle),
      blobRef = await this.putJson(JSON.parse(body)),
      ref = "wallet-body:" + randomUUID();
    await this.ctx.state.mutate((state) => {
      this.ctx.sessions.resolve(handle, state);
      transport(state).bodies.push({
        ref,
        ownerId: context.ownerId,
        clientId: context.clientId,
        blobRef,
        expiresAt: this.env.wall() + 86400000,
      });
    });
    return ref;
  }
  assertCurrent(handle: ClientHandle, record: RequestRecord, frozen: FrozenRequest): void {
    this.assertRequestContext(handle, record, frozen, true);
  }
  assertRetainedCurrent(handle: ClientHandle, record: RequestRecord, frozen: FrozenRequest): void {
    this.assertRequestContext(handle, record, frozen, false);
  }
  private assertRequestContext(
    handle: ClientHandle,
    record: RequestRecord,
    frozen: FrozenRequest,
    execution: boolean,
  ): void {
    const latest = this.owned(handle, record.requestId),
      context = this.ctx.sessions.resolve(handle);
    requireWallet(
      !latest.canceled &&
        this.env.wall() < latest.expiresAt &&
        latest.epoch === this.ctx.state.snapshot().managementEpoch &&
        (!execution ||
          ((latest.executionSessionId ?? latest.sessionId) === context.sessionId &&
            (latest.executionGeneration ?? latest.generation) === context.generation)),
      "WALLET_OPERATION_ABORTED",
      "The original live request context is no longer valid.",
    );
    if (latest.parentRequestId) {
      const all = transport(this.ctx.state.snapshot()).requests;
      let parent = all.find((r) => r.requestId === latest.parentRequestId),
        depth = 0;
      while (parent) {
        requireWallet(
          ++depth <= 32 &&
            !parent.canceled &&
            parent.ownerId === latest.ownerId &&
            parent.clientId === latest.clientId &&
            parent.epoch === latest.epoch,
          "WALLET_OPERATION_ABORTED",
          "The parent request is canceled, stale or unavailable.",
        );
        if (!parent.parentRequestId) break;
        parent = all.find((r) => r.requestId === parent!.parentRequestId);
        requireWallet(
          parent,
          "REQUEST_CONTEXT_UNAVAILABLE",
          "The parent operation history is incomplete.",
        );
      }
      requireWallet(parent, "REQUEST_CONTEXT_UNAVAILABLE", "The parent operation is unavailable.");
      const policy = this.replayPolicy(frozen);
      requireWallet(
        policy &&
          policy.expiresAt > this.env.wall() &&
          requestDigest(policy) === latest.replayPolicyDigest &&
          (latest.action === "refresh_quote" ? policy.safeReplay : policy.recoveryHeaders),
        "QUOTE_REFRESH_REQUIRED",
        "The approved replay contract expired or changed before transmission.",
      );
    }
    if (frozen.credentialRef)
      this.credentials.metadata(
        handle,
        frozen.credentialRef,
        frozen.url,
        frozen.credentialVersion!,
      );
  }
}
