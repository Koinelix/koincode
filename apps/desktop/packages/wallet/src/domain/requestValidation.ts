import { requireWallet } from "./errors.js";
import type { X402RequestInput } from "./requestModel.js";
export const REQUEST_LIMIT = 1024 * 1024;
export const MAX_CONCURRENT_HTTP_STAGES = 10;
export const RESPONSE_LIMIT = 64 * 1024 * 1024;
export const RESPONSE_WIRE_LIMIT = 72 * 1024 * 1024;
const RESERVED =
  /^(authorization|proxy-.*|cookie2?|set-cookie|host|connection|content-length|content-encoding|transfer-encoding|te|trailer|upgrade|expect|origin|referer|forwarded|x-forwarded-.*|payment-.*|x-payment.*|accept-encoding)$/i;
export function object(value: unknown): Record<string, unknown> {
  requireWallet(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "INVALID_REQUEST",
    "A request object is required.",
  );
  return value as Record<string, unknown>;
}
export function exactKeys(value: object, allowed: string[]): void {
  requireWallet(
    Object.keys(value).every((key) => allowed.includes(key)),
    "INVALID_REQUEST",
    "Unexpected request fields are not allowed.",
  );
}
export function headerName(name: string): string {
  requireWallet(
    typeof name === "string" && /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name) && !RESERVED.test(name),
    "INVALID_HEADER",
    "A reserved or invalid HTTP header was rejected.",
  );
  return name.toLowerCase();
}
export function jsonBody(value: unknown): string {
  const visit = (v: unknown, depth: number): void => {
    requireWallet(depth <= 32, "REQUEST_TOO_LARGE", "JSON nesting exceeds its limit.");
    if (v && typeof v === "object") {
      requireWallet(
        Array.isArray(v) ||
          Object.getPrototypeOf(v) === Object.prototype ||
          Object.getPrototypeOf(v) === null,
        "INVALID_REQUEST",
        "Only JSON data is supported.",
      );
      for (const key of Object.keys(v)) visit((v as Record<string, unknown>)[key], depth + 1);
    } else
      requireWallet(
        v === null ||
          typeof v === "string" ||
          typeof v === "boolean" ||
          (typeof v === "number" && Number.isFinite(v)),
        "INVALID_REQUEST",
        "Only finite JSON values are supported.",
      );
  };
  visit(value, 0);
  const body = JSON.stringify(value);
  requireWallet(
    Buffer.byteLength(body) <= REQUEST_LIMIT,
    "REQUEST_TOO_LARGE",
    "The request body exceeds its limit.",
  );
  return body;
}
export function validateInput(value: unknown): X402RequestInput {
  const input = object(value);
  exactKeys(input, [
    "url",
    "method",
    "headers",
    "bodyJson",
    "bodyRef",
    "credentialRef",
    "idempotency",
    "paymentMode",
    "responseMode",
    "requestContextRef",
    "requestContextAction",
  ]);
  requireWallet(
    input.responseMode === undefined || input.responseMode === "opaque" || input.responseMode === "image",
    "INVALID_REQUEST",
    "Invalid response mode.",
  );
  requireWallet(
    input.paymentMode === undefined ||
      input.paymentMode === "policy" ||
      input.paymentMode === "never",
    "INVALID_REQUEST",
    "Invalid payment mode.",
  );
  if (input.requestContextRef !== undefined) {
    requireWallet(
      typeof input.requestContextRef === "string" &&
        input.requestContextRef.length <= 100 &&
        input.paymentMode === "never" &&
        (input.requestContextAction === undefined ||
          ["recover", "refresh_quote"].includes(String(input.requestContextAction))),
      "INVALID_REQUEST",
      "Context actions require never mode.",
    );
    requireWallet(
      ["url", "method", "bodyJson", "bodyRef", "credentialRef", "idempotency"].every(
        (key) => input[key] === undefined,
      ),
      "REQUEST_CONFLICT",
      "A context action cannot replace the frozen request.",
    );
  } else {
    requireWallet(
      input.requestContextAction === undefined &&
        typeof input.url === "string" &&
        input.url.length <= 8192 &&
        ["GET", "POST"].includes(String(input.method)),
      "INVALID_REQUEST",
      "A bounded URL and GET or POST method are required.",
    );
    requireWallet(
      !(Object.hasOwn(input, "bodyJson") && input.bodyRef !== undefined) &&
        (input.method !== "GET" ||
          (!Object.hasOwn(input, "bodyJson") && input.bodyRef === undefined)),
      "INVALID_REQUEST",
      "Request body sources conflict with the method.",
    );
  }
  for (const key of ["bodyRef", "credentialRef"])
    requireWallet(
      input[key] === undefined ||
        (typeof input[key] === "string" && (input[key] as string).length <= 150),
      "INVALID_REQUEST",
      "An invalid opaque reference was supplied.",
    );
  if (input.idempotency !== undefined) {
    const idem = object(input.idempotency);
    exactKeys(idem, ["headerName"]);
    headerName(idem.headerName as string);
  }
  if (input.headers !== undefined) {
    const headers = object(input.headers),
      names = new Set<string>();
    requireWallet(Object.keys(headers).length <= 32, "INVALID_HEADER", "Too many request headers.");
    let size = 0;
    for (const [key, value] of Object.entries(headers)) {
      const name = headerName(key);
      requireWallet(
        !names.has(name) &&
          typeof value === "string" &&
          /^[\x20-\x7e]*$/.test(value) &&
          value.length <= 2048 &&
          name !==
            (input.idempotency as { headerName?: string } | undefined)?.headerName?.toLowerCase(),
        "INVALID_HEADER",
        "Invalid, duplicate or conflicting HTTP header.",
      );
      names.add(name);
      size += key.length + (value as string).length;
    }
    requireWallet(size <= 8192, "INVALID_HEADER", "Request headers exceed their limit.");
  }
  if (Object.hasOwn(input, "bodyJson")) jsonBody(input.bodyJson);
  return structuredClone(input) as X402RequestInput;
}
