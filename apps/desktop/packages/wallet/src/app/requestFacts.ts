import { createHash } from "node:crypto";
import { containsProtectedString } from "./responseStrings.js";
import type { RequestRecord, RequestView } from "../domain/requestModel.js";
export const canonicalRequest = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, "en")))
      : item,
  );
export const requestDigest = (value: unknown): string =>
  createHash("sha256").update(canonicalRequest(value)).digest("hex");
export const byteDigest = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export function view(record: RequestRecord): RequestView {
  const keys = [
    "requestId",
    "operationId",
    "transportStatus",
    "paymentStatus",
    "httpStatus",
    "responseHeaders",
    "bodyRef",
    "byteLength",
    "sha256",
    "paymentIntentId",
    "amountAtomic",
    "network",
    "transactionHash",
    "diagnosticCode",
    "relatedRequestId",
    "sensitiveRedacted",
    "reconciliationPending",
  ] as const;
  return structuredClone(
    Object.fromEntries(keys.filter((k) => record[k] !== undefined).map((k) => [k, record[k]])),
  ) as unknown as RequestView;
}
export function safeResponse(
  headers: Record<string, string>,
  body: Uint8Array,
  secrets: string[],
): { headers: Record<string, string>; body: Uint8Array; redacted: boolean } {
  const decodedSignatures = secrets.flatMap((value) => {
    try {
      return (
        Buffer.from(value, "base64")
          .toString("utf8")
          .match(/0x[0-9a-f]{130}/gi) ?? []
      );
    } catch {
      return [];
    }
  });
  const sensitive = [
    ...new Set(
      [...secrets, ...decodedSignatures]
        .flatMap((x) => [x, x.replace(/^Bearer /i, ""), ...(x.match(/0x[0-9a-f]{130}/gi) ?? [])])
        .filter((x) => x.length > 0),
    ),
  ];
  const contains = (text: string) => sensitive.some((secret) => text.includes(secret));
  const clean = (text: string) =>
    sensitive.reduce((value, secret) => value.split(secret).join("[REDACTED]"), text);
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers))
    if (
      ["content-type", "etag", "retry-after", "content-language", "cache-control"].includes(key) &&
      value.length <= 2048 &&
      !/[\r\n]/.test(value)
    )
      output[key] = clean(value);
  const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  let exposed = sensitive.some((secret) => bytes.includes(Buffer.from(secret)));
  if (!exposed && sensitive.length)
    exposed = containsProtectedString(bytes, headers["content-type"] ?? "", contains);
  if (exposed) {
    output["content-type"] = "application/json";
    return {
      headers: output,
      body: Buffer.from(
        '{"redacted":true,"message":"Response withheld: protected material was present or inspection could not complete."}',
      ),
      redacted: true,
    };
  }
  return { headers: output, body: Uint8Array.from(body), redacted: false };
}
