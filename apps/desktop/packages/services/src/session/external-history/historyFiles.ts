import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, normalize, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export type HistoryRecord = Record<string, unknown>;
export function record(value: unknown): HistoryRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as HistoryRecord)
    : {};
}
export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function timestamp(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Date.parse(string(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
export function sourceWorkspacePath(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): string {
  const path = string(value);
  if (!path) return "";
  try {
    if (path.startsWith("file:")) return fileURLToPath(path, { windows: platform === "win32" });
    if (platform === "win32")
      return /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path)
        ? win32.normalize(path)
        : "";
    return path.startsWith("/") ? normalize(path) : "";
  } catch {
    return "";
  }
}
export function sameWorkspace(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!left || !right) return false;
  if (platform === "win32")
    return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
  return normalize(resolve(left)) === normalize(resolve(right));
}
export async function historyFiles(root: string, suffix: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await historyFiles(path, suffix)));
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path);
  }
  return files;
}
export async function readHistoryLines(path: string, limit = Infinity): Promise<HistoryRecord[]> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const result: HistoryRecord[] = [];
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        result.push(record(JSON.parse(line)));
      } catch {
        throw new Error("history_invalid_jsonl");
      }
      if (result.length >= limit) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return result;
}
export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((item) => {
      const part = record(item);
      return ["text", "input_text", "output_text"].includes(string(part.type)) &&
        typeof part.text === "string"
        ? [part.text]
        : [];
    })
    .join("\n");
}
