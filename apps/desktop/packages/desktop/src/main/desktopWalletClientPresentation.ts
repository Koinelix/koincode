import { failure } from "./desktopWalletHostIdentity.js";

/** Descriptive client text is never payment evidence and may only repeat public input. */
export function clientPresentation(value: unknown, args: readonly string[], sensitive: readonly string[]): { version: 1; clientPrompt: string } | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "clientPrompt,version") throw failure("WALLET_CLIENT_RESULT_INVALID");
  const input = value as { version?: unknown; clientPrompt?: unknown };
  if (input.version !== 1 || typeof input.clientPrompt !== "string" || !input.clientPrompt ||
      Buffer.byteLength(input.clientPrompt, "utf8") > 6000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.clientPrompt))
    throw failure("WALLET_CLIENT_RESULT_INVALID");
  const prompt = input.clientPrompt;
  if (!args.includes(prompt) || /data:image\/|[A-Za-z0-9+/]{256,}={0,2}/i.test(prompt) ||
      sensitive.some(secret => secret.length >= 8 && prompt.includes(secret))) return;
  return { version: 1, clientPrompt: prompt };
}

/** Identify the file container from bytes, independently of the client's filename and MIME. */
export function verifiedImageType(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
}

export function collectPaymentSecrets(value: unknown, sensitive: string[], depth = 0): void {
  if (depth > 8 || sensitive.length >= 256) return;
  if (typeof value === "string" && value.length >= 8) sensitive.push(value);
  else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectPaymentSecrets(entry, sensitive, depth + 1);
  }
}
