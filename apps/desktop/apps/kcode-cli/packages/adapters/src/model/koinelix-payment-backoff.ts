import { setTimeout as delay } from "node:timers/promises";

/** Inspect only bounded pre-admission errors from the pinned Koinelix endpoint. */
async function knownRejection(response: Response, signed: boolean, signal: AbortSignal): Promise<boolean> {
  if (response.status !== (signed ? 503 : 429) || response.headers.has("payment-response") || response.headers.has("x-koinelix-request-id") ||
      !response.headers.get("content-type")?.startsWith("application/json") ||
      response.headers.has("content-encoding")) return false;
  const length = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length <= 0 || length > 2048) return false;
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(1500)]);
  const stop = () => { void reader.cancel().catch(() => {}); };
  deadline.addEventListener("abort", stop, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > length) return false;
      chunks.push(item.value);
    }
    if (deadline.aborted || size !== length) return false;
    const problem = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.error;
    if (!signed) return problem?.code === "capacity_exhausted" && problem.message === "Quote estimation capacity exhausted";
    return problem?.code === "payment_unavailable" && (problem.message === "Payment exposure could not be checked" ||
      problem.message === "Payment prerequisite could not be checked");
  } catch { return false; }
  finally { deadline.removeEventListener("abort", stop); stop(); reader.releaseLock(); }
}

export async function sendWithBackoff(send: () => Promise<Response>, signed: boolean, signal: AbortSignal): Promise<Response> {
  // A brief outage may outlast the initial burst. Keep using the original signed
  // request while the pinned platform explicitly says it never reached admission.
  const maxRetries = signed ? 6 : 4;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const response = await send();
    signal.throwIfAborted();
    const retry = attempt < maxRetries && await knownRejection(response, signed, signal);
    signal.throwIfAborted();
    if (!retry) return response;
    const header = response.headers.get("retry-after");
    let serverDelay = 0;
    if (header !== null) {
      serverDelay = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
      if (!Number.isFinite(serverDelay) || serverDelay > 15000) return response;
    }
    const wait = Math.max(serverDelay, Math.min(12000, 1000 * 2 ** attempt)) + Math.floor(Math.random() * 500);
    await response.body?.cancel();
    await delay(wait, undefined, { signal });
  }
}
