import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, isAbsolute } from "node:path";
import type { SessionId, ToolArtifactStorePort, TurnId } from "@fcode/contracts";

const MAX_BYTES = 32 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Publishes ordinary files from a trusted execution receipt. No payment or business-format handling. */
export async function publishClientArtifacts(value: unknown, options: {
  store?: ToolArtifactStorePort;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  signal: AbortSignal;
  assertCurrent(): void;
}) {
  const check = () => { options.signal.throwIfAborted(); options.assertCurrent(); };
  check();
  if (!object(value) || value.kind !== "client-result" || !Array.isArray(value.artifacts) || value.artifacts.length > 8)
    throw new Error("CLIENT_RESULT_INVALID");
  const artifacts = [];
  let total = 0;
  for (const item of value.artifacts) {
    check();
    if (!object(item) || typeof item.path !== "string" || !isAbsolute(item.path) ||
        typeof item.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(item.name) ||
        typeof item.mediaType !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(item.mediaType) ||
        typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_BYTES ||
        (total += item.bytes) > 2 * MAX_BYTES || typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256))
      throw new Error("CLIENT_ARTIFACT_INVALID");
    if (!options.store?.writeToolResultBinaryArtifact) throw new Error("CLIENT_ARTIFACT_STORE_UNAVAILABLE");
    const stat = await lstat(item.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== item.bytes || await realpath(item.path) !== item.path)
      throw new Error("CLIENT_ARTIFACT_CHANGED");
    const file = await open(item.path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    try {
      const opened = await file.stat();
      if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw new Error("CLIENT_ARTIFACT_CHANGED");
      const content = await file.readFile();
      try {
        check();
        if (content.length !== item.bytes || createHash("sha256").update(content).digest("hex") !== item.sha256)
          throw new Error("CLIENT_ARTIFACT_CHANGED");
        const result = await options.store.writeToolResultBinaryArtifact({
          sessionId: options.sessionId as SessionId, turnId: options.turnId as TurnId,
          toolCallId: options.toolCallId, toolName: options.toolName,
          content, contentType: item.mediaType, extension: extname(item.name) || ".bin", retention: "session",
        }, { signal: options.signal });
        check();
        if (!result.uri.startsWith(`fcode-artifact://${encodeURIComponent(options.sessionId)}/`) || result.bytes !== item.bytes)
          throw new Error("CLIENT_ARTIFACT_INVALID");
        artifacts.push({ uri: result.uri, name: item.name, mediaType: item.mediaType,
          bytes: item.bytes, sha256: item.sha256 });
      } finally { content.fill(0); }
    } finally { await file.close(); }
  }
  return { status: value.status, diagnosticCode: value.diagnosticCode, operationId: value.operationId,
    paymentId: value.paymentId, artifacts };
}
