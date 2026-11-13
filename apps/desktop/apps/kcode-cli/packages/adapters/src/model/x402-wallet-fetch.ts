import { sendWithBackoff } from "./koinelix-payment-backoff.js";
import { createHash, randomUUID } from "node:crypto";

const MAX_BODY = 1024 * 1024;
const AUTH_HEADERS = ["authorization", "x-api-key", "x-goog-api-key"];
const AUTH_QUERY = new Set(["key", "api_key", "api-key", "apikey"]);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export class UnsignedQuoteIncrease extends Error {}
/** The wallet no longer holds this operation's in-memory admission, for example after its service restarted. */
export class UnsignedAdmissionLost extends Error {}
const MAX_ADMISSION_RECOVERIES = 1;

export interface WalletFetchPayment {
  url: string;
  method: "GET" | "POST";
  requestDigest: string;
  bodySha256: string | null;
  bodyByteLength: number;
  credentialTag: null;
  paymentRequired: string;
}
export interface WalletFetchPort {
  acquire(operationId: string, payment: WalletFetchPayment, signal: AbortSignal): Promise<{ waited: boolean }>;
  release(operationId: string): Promise<void>;
  authorize(operationId: string, payment: WalletFetchPayment, idempotencyKey: string,
    contentType: string | null, signal: AbortSignal): Promise<{ paymentHeader: string }>;
  /** The durable Host owner starts recovery, independently of this request's aborted signal. */
  complete(operationId: string, paymentResponse: string | null): Promise<void>;
}

async function boundedBody(request: Request): Promise<Uint8Array | undefined> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_BODY) throw new Error("WALLET_REQUEST_TOO_LARGE");
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

/** Protocol-independent HTTP payment adapter; it never reads model fields or response usage. */
export function createX402WalletFetch(transport: typeof fetch, baseURL: string, port: WalletFetchPort, koinelix = false): typeof fetch {
  const origin = new URL(baseURL).origin;
  return async (input, init) => {
    const source = new Request(input, init);
    const url = new URL(source.url);
    if (url.origin !== origin || url.username || url.password || url.hash ||
        (source.method !== "POST" && source.method !== "GET")) throw new Error("WALLET_REQUEST_TARGET_INVALID");
    const headers = new Headers(source.headers);
    for (const name of AUTH_HEADERS) headers.delete(name);
    headers.delete("payment-signature");
    headers.delete("x-payment");
    for (const name of [...url.searchParams.keys()]) if (AUTH_QUERY.has(name.toLowerCase())) url.searchParams.delete(name);
    const operationId = randomUUID();
    headers.set("idempotency-key", operationId);
    const body = await boundedBody(source);
    const method = source.method as "GET" | "POST";
    const snapshot = { url: url.href, method, headers: [...headers.entries()],
      bodySha256: body === undefined ? null : hash(body), bodyByteLength: body?.byteLength ?? 0 };
    const request = (paymentHeader?: string) => {
      const outgoing = new Headers(headers);
      if (paymentHeader) outgoing.set("payment-signature", paymentHeader);
      return new Request(url, { method, headers: outgoing, body: body === undefined ? undefined : Buffer.from(body),
        signal: source.signal, redirect: "manual" });
    };
    const koinelixRoute = koinelix && method === "POST" &&
      (url.origin === "http://127.0.0.1:8080" || url.origin === "https://api.koinelix.com") &&
      (/^\/v1\/(responses|messages|chat\/completions)$/.test(url.pathname) ||
        /^\/v1beta\/models\/[a-zA-Z0-9._-]+:(streamGenerateContent|generateContent)$/.test(url.pathname));
    const send = (signature?: string) => {
      const sendOnce = () => transport(request(signature));
      return koinelixRoute ? sendWithBackoff(sendOnce, signature !== undefined, source.signal) : sendOnce();
    };
    const response = await send();
    if (response.status !== 402) return response;
    let challenge = response.headers.get("payment-required");
    await response.body?.cancel();
    if (!challenge || challenge.length > 32768) throw new Error("X402_INVALID_CHALLENGE");
    const payment: WalletFetchPayment = { url: url.href, method, requestDigest: hash(JSON.stringify(snapshot)),
      bodySha256: snapshot.bodySha256, bodyByteLength: snapshot.bodyByteLength, credentialTag: null, paymentRequired: challenge };
    let completed = false, receipt: string | null = null;
    const complete = () => {
      if (completed) return;
      completed = true;
      source.signal.removeEventListener("abort", aborted);
      void port.complete(operationId, receipt).catch(() => { /* Durable Host state retains recovery even when notification fails. */ });
    };
    const aborted = () => complete();
    try {
      const admissionSignal = AbortSignal.any([source.signal, AbortSignal.timeout(1_200_000)]);
      let material: { paymentHeader: string };
      let admissionRecoveries = 0;
      for (;;) {
        admissionSignal.throwIfAborted();
        const admission = await port.acquire(operationId, payment, admissionSignal);
        if (admission.waited) {
          const refreshed = await send();
          if (refreshed.status !== 402) {
            await port.release(operationId);
            return refreshed;
          }
          challenge = refreshed.headers.get("payment-required");
          await refreshed.body?.cancel();
          if (!challenge || challenge.length > 32768) throw new Error("X402_INVALID_CHALLENGE");
          payment.paymentRequired = challenge;
        }
        try {
          material = await port.authorize(operationId, payment, operationId, headers.get("content-type"), source.signal);
          break;
        } catch (error) {
          // Bug fix (2026-11-13): admission lives only in wallet memory. A wallet service that restarted between
          // prepare and authorize rejected the still unsigned operation with PAYMENT_ADMISSION_EXPIRED and failed the turn.
          // Admit the same operation once more. The wallet, not this adapter, refuses an operation that has an intent or
          // a signature, so this can never sign twice, and the business request and its idempotency key are unchanged.
          const lost = error instanceof UnsignedAdmissionLost && admissionRecoveries++ < MAX_ADMISSION_RECOVERIES;
          if (!(error instanceof UnsignedQuoteIncrease) && !lost) throw error;
          await port.release(operationId);
        }
      }
      if (!material || typeof material.paymentHeader !== "string" || material.paymentHeader.length > 65536)
        throw new Error("WALLET_PAYMENT_RESPONSE_INVALID");
      source.signal.addEventListener("abort", aborted, { once: true });
      source.signal.throwIfAborted();
      const paid = await send(material.paymentHeader);
      receipt = paid.headers.get("payment-response");
      if (receipt && receipt.length > 32768) receipt = null;
      if (!paid.ok || !paid.body) { complete(); return paid; }
      const reader = paid.body.getReader();
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const item = await reader.read();
            if (item.done) { controller.close(); reader.releaseLock(); complete(); }
            else controller.enqueue(item.value);
          } catch (error) { controller.error(error); reader.releaseLock(); complete(); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); complete(); } },
      }, { highWaterMark: 0 }), { status: paid.status, statusText: paid.statusText, headers: paid.headers });
    } catch (error) { complete(); throw error; }
    finally { void port.release(operationId).catch(() => {}); }
  };
}
