import { RemoteHostError } from "@fcode/shared";

const MAX_UTF8_CHARACTER_BYTES = 4;
const CONTINUATION_MASK = 0xc0;
const CONTINUATION_PREFIX = 0x80;

/** Validate the whole bounded file before exposing even its first text page. */
export class RemoteUtf8TextValidator {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  push(bytes: Uint8Array): void {
    if (bytes.some((value) => value < 0x20 && value !== 0x09 && value !== 0x0a && value !== 0x0d || value === 0x7f)) {
      throw new RemoteHostError("path_not_allowed", "Structured file reads only support UTF-8 text without binary control bytes.");
    }
    try { this.decoder.decode(bytes, { stream: true }); }
    catch { throw new RemoteHostError("path_not_allowed", "The remote file is not valid UTF-8 text."); }
  }

  finish(): void {
    try { this.decoder.decode(); }
    catch { throw new RemoteHostError("path_not_allowed", "The remote file ends with an incomplete UTF-8 character."); }
  }
}

export const REMOTE_UTF8_PAGE_LOOKAHEAD = MAX_UTF8_CHARACTER_BYTES;

export function remoteUtf8TextPage(bytes: Buffer, maxBytes: number): Buffer {
  const continuation = (value: number) => (value & CONTINUATION_MASK) === CONTINUATION_PREFIX;
  if (bytes.length && continuation(bytes[0]!)) {
    throw new RemoteHostError("invalid_request", "The read offset must be at a UTF-8 character boundary. Use the previous nextOffset.");
  }
  let end = Math.min(bytes.length, maxBytes);
  while (end < bytes.length && end > 0 && continuation(bytes[end]!)) end--;
  if (bytes.length && !end) {
    throw new RemoteHostError("invalid_request", "Increase maxBytes to fit the next complete UTF-8 character.");
  }
  return bytes.subarray(0, end);
}
