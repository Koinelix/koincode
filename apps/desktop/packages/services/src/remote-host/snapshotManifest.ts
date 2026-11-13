import { createHash } from "node:crypto";
import { posix } from "node:path";
import { REMOTE_HOST_LIMITS, RemoteHostError, type RemoteManifestEntry } from "@fcode/shared";

// eslint-disable-next-line no-control-regex -- Reject terminal-control characters in upload names.
const INVALID_NAME = /[\u0000-\u001f\u007f]/;
const SENSITIVE_DIRECTORIES = new Set([".ssh", ".aws", ".azure", ".kube", "gcloud"]);
const SENSITIVE_NAMES = /^(?:\.env(?:[.-].*)?|\.npmrc|\.netrc|\.pypirc|id_.*|credentials(?:\..*)?)$|\.(?:pem|p12|pfx)$/i;

export function isSensitiveUploadPath(value: string): boolean {
  const parts = value.replaceAll("\\", "/").split("/");
  return parts.some((part) => SENSITIVE_DIRECTORIES.has(part.toLowerCase())) || SENSITIVE_NAMES.test(parts.at(-1) ?? "");
}

export function validateUploadEntryName(relativePath: string): boolean {
  return !INVALID_NAME.test(relativePath) && !posix.isAbsolute(relativePath) &&
    !relativePath.split("/").some((part) => part === ".." || !part) &&
    Buffer.byteLength(relativePath, "utf8") <= REMOTE_HOST_LIMITS.pathBytes;
}

export function remoteManifestHash(entries: readonly RemoteManifestEntry[]): string {
  const ordered = [...entries].sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)));
  return createHash("sha256").update(JSON.stringify({ version: 1, entries: ordered.map((entry) => [
    entry.type, entry.relativePath, entry.size, entry.mode, entry.sha256 ?? null,
  ]) })).digest("hex");
}

export function filterRemoteManifest(entries: readonly RemoteManifestEntry[], patterns: readonly string[]): RemoteManifestEntry[] {
  if (!patterns.length) return [...entries];
  for (const pattern of patterns) {
    if (INVALID_NAME.test(pattern) || posix.isAbsolute(pattern) || pattern.split("/").includes("..")) {
      throw new RemoteHostError("invalid_request", "Upload exclusions must be relative glob patterns.");
    }
  }
  return entries.filter((entry) => !patterns.some((pattern) =>
    posix.matchesGlob(entry.relativePath, pattern) ||
    entry.relativePath.split("/").slice(0, -1).some((_, index, parts) => posix.matchesGlob(parts.slice(0, index + 1).join("/"), pattern))));
}

export function uploadMode(mode: number, directory: boolean, platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? directory ? 0o755 : 0o644 : mode & 0o777;
}
