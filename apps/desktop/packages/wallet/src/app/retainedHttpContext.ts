import { requireWallet } from "../domain/errors.js";

export interface RetainedHttpContext {
  version: 1;
  requestId: string;
  phase: "initial" | "paid";
  paymentIntentId: string | null;
  status: number;
  headers: Record<string, string>;
  secrets: string[];
  receivedAt: number;
  receivedMonotonic: number;
  clockId: string;
}
function validate(value: unknown): asserts value is RetainedHttpContext {
  const r = value as RetainedHttpContext;
  requireWallet(!!r && typeof r === "object" && !Array.isArray(r) &&
    Object.keys(r).sort().join(",") === "clockId,headers,paymentIntentId,phase,receivedAt,receivedMonotonic,requestId,secrets,status,version" &&
    typeof r.requestId === "string" && /^[0-9a-f-]{36}$/.test(r.requestId) &&
    (r.phase === "initial" ? r.paymentIntentId === null : r.phase === "paid" &&
      typeof r.paymentIntentId === "string" && /^[0-9a-f-]{36}$/.test(r.paymentIntentId)) &&
    r.version === 1 && Number.isInteger(r.status) && r.status >= 100 && r.status <= 599 &&
    Number.isSafeInteger(r.receivedAt) && r.receivedAt >= 0 &&
    Number.isFinite(r.receivedMonotonic) && r.receivedMonotonic >= 0 &&
    typeof r.clockId === "string" && /^[0-9a-f-]{36}$/.test(r.clockId) &&
    !!r.headers && typeof r.headers === "object" && !Array.isArray(r.headers) &&
    Object.keys(r.headers).length <= 256 && Object.entries(r.headers).every(([key, val]) =>
      key.length <= 256 && /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key) &&
      typeof val === "string" && val.length <= 65536 && !/[\r\n]/.test(val)) &&
    Array.isArray(r.secrets) && r.secrets.length <= 32 &&
    r.secrets.every(secret => typeof secret === "string" && secret.length <= 262144),
  "RESPONSE_RETENTION_UNAVAILABLE", "The retained HTTP context is invalid.");
}
export function encodeRetainedHttpContext(value: RetainedHttpContext): Uint8Array {
  validate(value);
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.byteLength > 1048576) {
    bytes.fill(0);
    requireWallet(false, "RESPONSE_RETENTION_UNAVAILABLE", "The retained HTTP context exceeds its bound.");
  }
  return bytes;
}
export function decodeRetainedHttpContext(bytes: Uint8Array): RetainedHttpContext {
  requireWallet(bytes.byteLength > 0 && bytes.byteLength <= 1048576,
    "RESPONSE_RETENTION_UNAVAILABLE", "The retained HTTP context exceeds its bound.");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { requireWallet(false, "RESPONSE_RETENTION_UNAVAILABLE", "The retained HTTP context cannot be decoded."); }
  validate(value);
  return value;
}
