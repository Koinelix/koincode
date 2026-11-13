import { createHash } from "node:crypto";
import { RemoteHostError } from "@fcode/shared";

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  throw new RemoteHostError("invalid_request", "The operation contains unsupported input values.");
}

export function remoteInputDigest(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(input))).digest("hex");
}
