/** A remote upload is a broker source, never a provider-context attachment. Check before content, metadata, or history projection. */
export function assertModelContextAttachment(attachment: unknown): void {
  if (typeof attachment !== "object" || attachment === null) return;
  const purpose = (attachment as { purpose?: unknown }).purpose;
  if (purpose !== undefined && purpose !== "model_context") throw new Error("Upload-only attachments cannot enter model context. Use a Remote Host source_id.");
}
