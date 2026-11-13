import type { FrozenRequest } from "../domain/requestModel.js";
export interface OutboundAuthorizationContext {
  readonly version: 1;
  readonly requestId: string;
  readonly operationId: string;
  readonly inputDigest: string;
  readonly frozenDigest: string;
  readonly managementEpoch: string;
  readonly action: "request" | "recover" | "refresh_quote";
  readonly stage: "before_sign" | "before_initial_http" | "before_paid_http";
  readonly source: "client_operation" | "wallet_refresh";
  readonly createdBy: Readonly<{ sessionId: string; generation: number }>;
  readonly parent: Readonly<{
    requestId: string;
    operationId: string;
    action: "request" | "recover" | "refresh_quote";
    inputDigest: string;
    frozenDigest: string;
  }> | null;
}
export interface ResponseReservation {
  put(value: Uint8Array): Promise<string>;
  release(): void;
}
export interface BlobStore {
  // Reserve before any HTTP effect, and before signing a paid stage.
  reserveResponse(purpose?: "payment-material"): ResponseReservation;
  put(value: Uint8Array): Promise<string>;
  // Each read transfers an independent mutable buffer to the caller, which may clear it.
  // Never share this buffer with retained storage or another reader.
  get(ref: string): Promise<Uint8Array>;
}
export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}
export type HttpContextStage = "dns" | "connect" | "submit";
export type HttpContextCheck = (stage: HttpContextStage) => boolean;
export type OutboundEffect = "prepare_http" | HttpContextStage | "sign";
export interface ControlledHttp {
  send(
    request: FrozenRequest,
    secretHeaders: Readonly<Record<string, string>>,
    signal: AbortSignal,
    checkContext: HttpContextCheck,
  ): Promise<HttpResult>;
}
export interface RequestEnvironment {
  blobs: BlobStore;
  retainedBlobs?: import("./responseRetentionOwner.js").RetainedResponseBlobs;
  http: ControlledHttp;
  inspectResponse(
    headers: Record<string, string>,
    body: Uint8Array,
    secrets: string[],
    signal: AbortSignal,
  ): Promise<{ headers: Record<string, string>; body: Uint8Array; redacted: boolean }>;
  authorize(
    request: Readonly<FrozenRequest>,
    client: import("../domain/model.js").ClientContext,
    phase: "initial" | "paid" | "recover" | "refresh_quote",
    signal: AbortSignal | undefined,
    context: OutboundAuthorizationContext,
  ): Promise<boolean>;
  checkOutbound(
    client: import("../domain/model.js").ClientContext,
    context: OutboundAuthorizationContext,
    effect: OutboundEffect,
  ): boolean;
  delay(milliseconds: number, signal: AbortSignal): Promise<void>;
  wall(): number;
  monotonic(): number;
}
export interface RequestWork {
  signal: AbortSignal;
  callerSignal?: AbortSignal;
  assertCurrent(): void;
}
