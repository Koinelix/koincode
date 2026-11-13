import type { openLocalWalletRequests, OutboundAuthorizationContext } from "@koincode/wallet/node";
import { isWalletMessage } from "./desktopWalletProtocol.js";
import { WALLET_HOST_TIMEOUT_MS } from "@fcode/shared";

export type WalletRequestOptions = Parameters<typeof openLocalWalletRequests>[0];
export type WalletOutboundClient = Parameters<WalletRequestOptions["checkOutbound"]>[0];
export const OUTBOUND_TTL_MS = 60_000;
export const OUTBOUND_OPERATION_TTL_MS = WALLET_HOST_TIMEOUT_MS;
export const OUTBOUND_CAPACITY = 32;
export const OUTBOUND_PAGE_UNITS = 16 * 1024;
// A canonical 1 MiB JSON body can double when quoted; reserve bounded metadata headroom.
export const OUTBOUND_TEXT_UNITS = 3 * 1024 * 1024;
export interface WalletOutboundRequest {
  type: "outbound-request";
  approvalId: string;
  generation: string;
  client: WalletOutboundClient;
  context: OutboundAuthorizationContext;
  url: string;
  method: "GET" | "POST";
  bodyBytes: number;
  inspectionUnits: number;
  hostPayment?: boolean;
}
export function outboundId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
function digest(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function action(value: unknown): boolean {
  return value === "request" || value === "recover" || value === "refresh_quote";
}
function integer(value: unknown, max: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
export function isOutboundRequest(value: unknown): value is WalletOutboundRequest {
  if (
    !isWalletMessage(value) ||
    value.type !== "outbound-request" ||
    !outboundId(value.approvalId) ||
    !outboundId(value.generation)
  )
    return false;
  const c = value.client,
    x = value.context;
  if (!isWalletMessage(c) || !isWalletMessage(x) || !isWalletMessage(x.createdBy)) return false;
  const parent = x.parent;
  return (
    id(c.ownerId) &&
    id(c.clientId) &&
    id(c.sessionId) &&
    integer(c.generation, Number.MAX_SAFE_INTEGER) &&
    (c.identityLevel === "verified" || c.identityLevel === "token_only") &&
    x.version === 1 &&
    id(x.requestId) &&
    id(x.operationId) &&
    id(x.managementEpoch) &&
    digest(x.inputDigest) &&
    digest(x.frozenDigest) &&
    action(x.action) &&
    typeof x.stage === "string" &&
    ["before_initial_http", "before_paid_http", "before_sign"].includes(x.stage) &&
    (x.source === "client_operation" || x.source === "wallet_refresh") &&
    id(x.createdBy.sessionId) &&
    integer(x.createdBy.generation, Number.MAX_SAFE_INTEGER) &&
    (parent === null ||
      (isWalletMessage(parent) &&
        id(parent.requestId) &&
        id(parent.operationId) &&
        action(parent.action) &&
        digest(parent.inputDigest) &&
        digest(parent.frozenDigest))) &&
    typeof value.url === "string" &&
    value.url.length <= 8192 &&
    (value.hostPayment === undefined || typeof value.hostPayment === "boolean") &&
    (value.method === "GET" || value.method === "POST") &&
    integer(value.bodyBytes, 1024 * 1024) &&
    integer(value.inspectionUnits, OUTBOUND_TEXT_UNITS)
  );
}

/** Stable binding includes every identity field; property insertion order is irrelevant. */
export function outboundBinding(c: WalletOutboundClient, x: OutboundAuthorizationContext): string {
  const p = x.parent;
  return JSON.stringify([
    c.ownerId,
    c.clientId,
    c.sessionId,
    c.generation,
    c.identityLevel,
    x.version,
    x.requestId,
    x.operationId,
    x.inputDigest,
    x.frozenDigest,
    x.managementEpoch,
    x.action,
    x.source,
    x.createdBy.sessionId,
    x.createdBy.generation,
    p && [p.requestId, p.operationId, p.action, p.inputDigest, p.frozenDigest],
  ]);
}
