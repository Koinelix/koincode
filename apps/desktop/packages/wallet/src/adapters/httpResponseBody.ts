import type { IncomingMessage } from "node:http";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { RESPONSE_LIMIT, RESPONSE_WIRE_LIMIT } from "../domain/requestValidation.js";
import { requireWallet, WalletError } from "../domain/errors.js";

// The HTTP adapter retains its active slot until this pipeline settles.
export async function readHttpResponseBody(response: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let wireBytes = 0, decodedBytes = 0;
  const wire = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      wireBytes += chunk.length;
      done(wireBytes > RESPONSE_WIRE_LIMIT
        ? new WalletError("HTTP_RESPONSE_TOO_LARGE", "The encoded response exceeds its limit.") : null, chunk);
    },
  });
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      decodedBytes += chunk.length;
      if (decodedBytes > RESPONSE_LIMIT) {
        done(new WalletError("HTTP_RESPONSE_TOO_LARGE", "The decoded response exceeds its limit."));
        return;
      }
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  try {
    const encoding = response.headers["content-encoding"];
    requireWallet(!encoding || ["identity", "gzip", "deflate", "br"].includes(encoding),
      "HTTP_RESPONSE_INVALID", "Unsupported response encoding.");
    const decoder = encoding === "gzip" ? createGunzip()
      : encoding === "deflate" ? createInflate()
      : encoding === "br" ? createBrotliDecompress() : undefined;
    if (decoder) await pipeline(response, wire, decoder, output, { signal });
    else await pipeline(response, wire, output, { signal });
    requireWallet(response.complete, "HTTP_UNKNOWN", "The HTTP response is incomplete.");
    signal.throwIfAborted();
    return Buffer.concat(chunks, decodedBytes);
  } catch (error) {
    response.destroy();
    wire.destroy();
    output.destroy();
    if (error instanceof WalletError) throw error;
    throw new WalletError(signal.aborted ? "WALLET_OPERATION_ABORTED" : "HTTP_RESPONSE_INVALID",
      "The response could not be completely and safely decoded.");
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    chunks.length = 0;
  }
}
