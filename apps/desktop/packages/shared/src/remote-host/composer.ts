import type { RemoteSelection } from "./contracts.js";

/** Renderer-only immutable send snapshot. Host consumes the issued selection before CLI admission. */
export interface RemoteHostComposerSelection {
  workspaceKey: string;
  binding: RemoteSelection["binding"];
  targets: Array<{ hostId: string; securityRevision: number; trustRevision: number }>;
  sourceIds: string[];
}

/** A local UI gesture consumes a standalone command; this never grants execution authority. */
export function isRemoteHostCommandOnly(text: string): boolean {
  return text.trim() === "/remote-host" && isRemoteHostCommandContext(text.slice(0, text.indexOf("/remote-host") + "/remote-host".length));
}

/** Keep the reserved UI action out of Markdown literal contexts while the user is composing. */
export function isRemoteHostCommandContext(prefix: string): boolean {
  let fence: { marker: string; length: number } | undefined;
  let inlineTicks = 0;
  let quoted = false;
  let indented = false;
  for (const line of prefix.replaceAll("\r\n", "\n").split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (!line.trim()) { quoted = false; inlineTicks = 0; indented = false; continue; }
    if (/^ {0,3}(?:(?:[-+*]|\d+[.)])[ \t]+)? {0,3}>/.test(line)) quoted = true;
    if (quoted) continue;
    indented = /^(?: {4}| *\t)/.test(line);
    if (indented) { inlineTicks = 0; continue; }
    if (!inlineTicks && marker && (marker[1]![0] !== "`" || !marker[2]!.includes("`"))) {
      fence = { marker: marker[1]![0]!, length: marker[1]!.length }; continue;
    }
    for (let i = 0; i < line.length; i++) {
      if (!inlineTicks && line[i] === "\\") { i++; continue; }
      if (line[i] !== "`") continue;
      let end = i + 1;
      while (line[end] === "`") end++;
      const length = end - i;
      if (inlineTicks === length) inlineTicks = 0;
      else if (!inlineTicks) inlineTicks = length;
      i = end - 1;
    }
  }
  return !fence && !inlineTicks && !quoted && !indented;
}
