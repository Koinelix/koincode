import type { Duplex } from "node:stream";
import { WalletError } from "../domain/errors.js";
import type { createAuthenticatedPaymentClient } from "./paymentClient.js";

const MAX_FRAME_BYTES = 128 * 1024;
const MAX_CALLS = 128;
const MAX_PENDING = 8;

/** Raw client protocol, never an LLM-facing MCP result. Authentication precedes this adapter. */
export async function serveAuthenticatedPaymentProtocol(stream: Duplex,
  client: ReturnType<typeof createAuthenticatedPaymentClient>): Promise<void> {
  const lifetime = new AbortController();
  const work = new Set<Promise<void>>();
  const timeout = setTimeout(() => { lifetime.abort(); stream.destroy(); }, 50 * 60 * 1000);
  timeout.unref();
  let buffer = Buffer.alloc(0), lastId = 0;
  const close = () => { lifetime.abort(); stream.destroy(); };
  const done = new Promise<void>(resolve => stream.once("close", () => { lifetime.abort(); resolve(); }));
  stream.on("error", close);
  stream.once("end", close);
  stream.on("data", (bytes: Buffer) => {
    if (lifetime.signal.aborted) return;
    if (buffer.length + bytes.length > MAX_FRAME_BYTES) { close(); return; }
    buffer = Buffer.concat([buffer, bytes]);
    for (let end; (end = buffer.indexOf(10)) >= 0;) {
      const line = buffer.subarray(0, end).toString("utf8"); buffer = buffer.subarray(end + 1);
      let value: Record<string, unknown>;
      try { value = JSON.parse(line) as Record<string, unknown>; }
      catch { close(); return; }
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).sort().join(",") !== "id,method,params,version" || value.version !== 1 ||
          value.id !== lastId + 1 || typeof value.method !== "string" || !value.params ||
          typeof value.params !== "object" || Array.isArray(value.params) || work.size >= MAX_PENDING) { close(); return; }
      const id = value.id as number; lastId = id;
      if (lastId > MAX_CALLS) { close(); return; }
      // Independent calls allow cancel/query to reach a payment waiting on native approval.
      const job = (async () => {
        try {
          const result = await client.call(value.method as string, value.params as Record<string, unknown>, lifetime.signal);
          if (!lifetime.signal.aborted) stream.write(JSON.stringify({ version: 1, id, ok: true, value: result }) + "\n");
        } catch (error) {
          if (!lifetime.signal.aborted) stream.write(JSON.stringify({ version: 1, id, ok: false,
            code: error instanceof WalletError ? error.code : "WALLET_REQUEST_FAILED" }) + "\n");
        }
        if (stream.writableLength > MAX_FRAME_BYTES) close();
      })().catch(close).finally(() => { work.delete(job); });
      work.add(job);
    }
  });
  stream.resume();
  await done;
  await Promise.allSettled(work);
  clearTimeout(timeout);
  buffer.fill(0);
}
