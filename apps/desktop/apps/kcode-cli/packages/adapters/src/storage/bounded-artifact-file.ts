import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Bound allocation using the opened file, including a check for concurrent growth. */
export async function readBoundedArtifactFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid artifact read limit");
  signal?.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("fault.attachment.previewTooLarge");
    const content = Buffer.allocUnsafe(info.size + 1);
    let offset = 0;
    while (offset < content.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(content, offset, content.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error("fault.attachment.previewChangedDuringRead");
    signal?.throwIfAborted();
    return content.subarray(0, offset);
  } finally {
    await file.close();
  }
}
