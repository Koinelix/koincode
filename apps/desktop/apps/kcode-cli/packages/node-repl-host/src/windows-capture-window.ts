import type { NodeReplRunResult } from "@fcode/core/repl";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { containsOfficialCuaImageRefCredentialText } from "@fcode/cua/frame-contract";
import { cuaScreenshotContentIndices } from "./capture-provenance.js";

const WINDOWS_CAPTURE_WINDOW = 3;

/** Preserve authenticated Browser occurrences even when structured CUA pixels are identical. */
export function buildWindowsCuaResultContent(
  run: NodeReplRunResult,
  structuredContent: CallToolResult["content"],
  suffix: CallToolResult["content"],
) {
  const hasStructured = (run.structuredResults?.length ?? 0) > 0;
  const content: CallToolResult["content"] = hasStructured && !run.error ? [...structuredContent] : [];
  const browserImageIndices = new Set(run.browserScreenshotImageIndices ?? []);
  const browserContentIndices: number[] = [];
  (run.images ?? []).forEach((image, index) => {
    if (!hasStructured && run.error) return;
    const browser = browserImageIndices.has(index);
    if (hasStructured && !browser && structuredContent.some((block) =>
      block.type === "image" && block.data === image.base64)) return;
    if (browser) browserContentIndices.push(content.length);
    content.push({ type: "image", data: image.base64, mimeType: image.mimeType });
  });
  content.push(...suffix);
  return projectWindowsCuaScreenshotWindow(content, run.cuaCaptures, browserContentIndices);
}

/** Drop superseded Windows captures before transfer, retaining other media and text. */
export function projectWindowsCuaScreenshotWindow<T extends {
  type: string; data?: unknown; mimeType?: unknown; text?: unknown;
}>(content: T[], captures: NodeReplRunResult["cuaCaptures"],
  browserIndices: number[] = []) {
  const browserSet = new Set(browserIndices);
  const captureIndices = cuaScreenshotContentIndices(content.map((block, index) =>
    browserSet.has(index) ? { type: "browser" } : block), captures);
  const overflow = Math.max(0, captureIndices.length - WINDOWS_CAPTURE_WINDOW);
  if (!overflow) return { content, captureIndices, browserIndices };
  const removedIndices = captureIndices.slice(0, overflow);
  const dropped = new Set(removedIndices);
  for (const index of removedIndices) {
    const next = content[index + 1];
    if (next?.type === "text" && typeof next.text === "string" &&
        containsOfficialCuaImageRefCredentialText(next.text)) dropped.add(index + 1);
  }
  const capturesSet = new Set(captureIndices.slice(overflow));
  const projected: T[] = [];
  const projectedCaptures: number[] = [];
  const projectedBrowser: number[] = [];
  content.forEach((block, index) => {
    if (dropped.has(index)) return;
    if (capturesSet.has(index)) projectedCaptures.push(projected.length);
    if (browserSet.has(index)) projectedBrowser.push(projected.length);
    projected.push(block);
  });
  return { content: projected, captureIndices: projectedCaptures, browserIndices: projectedBrowser };
}
