import { createHash } from "node:crypto";
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, "en")))
      : item,
  );
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function eventHash(previous: string, event: unknown): string {
  return createHash("sha256")
    .update(previous + "\0" + canonical(event))
    .digest("hex");
}
