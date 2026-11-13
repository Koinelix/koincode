import type { ToolArtifactStorePort, TraceContext } from "@fcode/contracts";

type Media = { bytes: Uint8Array; mediaType: string };

function isPreviewMedia(value: string): boolean {
  return value.startsWith("image/") || value.startsWith("video/") || value === "application/pdf";
}

function decodeDataUrl(content: string, fallbackMime: string, maxBytes: number): Media {
  const comma = content.indexOf(",");
  const parts = content.slice(0, 5).toLowerCase() === "data:" && comma >= 0
    ? content.slice(5, comma).split(";") : [];
  const mediaType = (parts.shift()?.trim() || fallbackMime).split(";", 1)[0]!.toLowerCase();
  const payload = comma >= 0 ? content.slice(comma + 1) : "";
  if (parts.at(-1)?.trim().toLowerCase() !== "base64" ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload) || payload.length % 4 !== 0)
    throw new Error("fault.attachment.previewArtifactInvalid");
  if (!isPreviewMedia(mediaType)) throw new Error("fault.attachment.previewNotMedia");
  const bytes = Buffer.from(payload, "base64");
  if (bytes.byteLength > maxBytes) throw new Error("fault.attachment.previewTooLarge");
  return { bytes, mediaType };
}

/** The caller must authorize the artifact against the current session before invoking this. */
export async function readPromptArtifactMedia(
  store: ToolArtifactStorePort,
  input: { uri: string; fallbackMime: string; maxBytes: number; trace?: TraceContext },
): Promise<Media> {
  const request = { uri: input.uri, trace: input.trace };
  const stat = await store.statToolResultArtifact?.(request);
  const storedType = stat?.contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (isPreviewMedia(storedType)) {
    if (stat!.bytes > input.maxBytes) throw new Error("fault.attachment.previewTooLarge");
    if (!store.readToolResultBinaryArtifact) throw new Error("fault.attachment.readUnsupported");
    const result = await store.readToolResultBinaryArtifact({ ...request, maxBytes: input.maxBytes });
    if (result.contentType.split(";", 1)[0]?.trim().toLowerCase() !== storedType)
      throw new Error("fault.attachment.previewChangedDuringRead");
    if (result.bytes.byteLength > input.maxBytes) throw new Error("fault.attachment.previewTooLarge");
    return { bytes: result.bytes, mediaType: storedType };
  }
  const artifact = await store.readToolResultArtifact(request);
  return decodeDataUrl(artifact.content, input.fallbackMime, input.maxBytes);
}
