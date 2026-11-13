// JSON.parse owns escape decoding. This scanner only locates string boundaries.
// Run untrusted response inspection in the adapter's bounded worker, not the wallet event loop.
export function containsProtectedString(
  bytes: Uint8Array,
  contentType: string,
  contains: (text: string) => boolean,
): boolean {
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  const declaredJson = mediaType.endsWith("/json") || mediaType.endsWith("+json");
  const prefix = raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  let first = prefix;
  while ([9, 10, 13, 32].includes(raw[first]!)) first++;
  const json =
    declaredJson ||
    ((!mediaType || mediaType.startsWith("text/")) && [34, 91, 123].includes(raw[first]!));
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    if (json) return true;
    // Preserve opaque binary compatibility while recognizing ASCII escape candidates.
    text = raw.toString("latin1");
  }
  if (json) {
    try {
      // Validation only: duplicate property values are inspected independently below.
      JSON.parse(text);
    } catch {
      return true;
    }
  }
  const nextQuote = (after: number): number => {
    let quote = text.indexOf('"', after);
    while (quote !== -1) {
      let backslash = quote - 1;
      while (backslash >= 0 && text[backslash] === "\\") backslash--;
      if ((quote - 1 - backslash) % 2 === 0) return quote;
      quote = text.indexOf('"', quote + 1);
    }
    return -1;
  };
  let start = nextQuote(0);
  while (start !== -1) {
    const end = nextQuote(start + 1);
    const literal = end === -1 ? text.slice(start) + '"' : text.slice(start, end + 1);
    try {
      const decoded: unknown = JSON.parse(literal);
      if (typeof decoded === "string" && contains(decoded)) return true;
    } catch {
      // Opaque overlapping candidates need not be valid strings. JSON was validated above.
    }
    if (end === -1) break;
    // In opaque text a closing quote is also a possible opening quote, so a stray
    // prefix quote cannot hide a later encoded secret. Total candidate length is bounded.
    start = json ? nextQuote(end + 1) : end;
  }
  return false;
}
