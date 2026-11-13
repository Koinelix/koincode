import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ALLOWED = new Set(["eip155:1", "eip155:8453", "eip155:42161", "eip155:10", "eip155:56", "eip155:137", "eip155:43114"]);
const TESTNETS = new Set(["eip155:11155111", "eip155:84532", "eip155:421614", "eip155:11155420", "eip155:97", "eip155:80002", "eip155:43113"]);
type NetworkVisibility = { showTestnets: boolean; hidden: string[] };

function parseVisibility(value: unknown): NetworkVisibility {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "hidden,showTestnets")
    throw new Error("GENERAL_PREFERENCES_INVALID");
  const item = value as Record<string, unknown>;
  if (typeof item.showTestnets !== "boolean" || !Array.isArray(item.hidden) || item.hidden.length > 13 ||
      item.hidden.some((id) => typeof id !== "string" || !ALLOWED.has(id) && !TESTNETS.has(id)) ||
      new Set(item.hidden).size !== item.hidden.length || [...ALLOWED].every((id) => (item.hidden as unknown[]).includes(id)))
    throw new Error("GENERAL_PREFERENCES_INVALID");
  return { showTestnets: item.showTestnets, hidden: [...item.hidden].sort() as string[] };
}

function parse(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > ALLOWED.size || value.some((id) => typeof id !== "string" || !ALLOWED.has(id)) ||
      new Set(value).size !== value.length) throw new Error("GENERAL_PREFERENCES_INVALID");
  return [...value].sort();
}

/** Local display choices only; no wallet identity, balance, credential or payment configuration. */
export class DesktopGeneralWalletPreferences {
  private readonly filename: string;
  private readonly visibilityFilename: string;
  private pending: Promise<void> = Promise.resolve();
  private visibilityPending: Promise<void> = Promise.resolve();
  constructor(directory: string) {
    this.filename = join(directory, "general-wallet-display-v1.json");
    this.visibilityFilename = join(directory, "general-wallet-networks-v1.json");
  }

  private async loadVisibility(): Promise<NetworkVisibility | null> {
    let file;
    try {
      file = await open(this.visibilityFilename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await file.stat();
      if (!info.isFile() || info.size > 4096) throw new Error("GENERAL_PREFERENCES_INVALID");
      const bytes = Buffer.alloc(4097), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 4096) throw new Error("GENERAL_PREFERENCES_INVALID");
      const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).sort().join() !== "hidden,showTestnets,version" || (value as { version: unknown }).version !== 1)
        throw new Error("GENERAL_PREFERENCES_INVALID");
      const { hidden, showTestnets } = value as Record<string, unknown>;
      return parseVisibility({ hidden, showTestnets });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw new Error("GENERAL_PREFERENCES_UNAVAILABLE");
    } finally { await file?.close(); }
  }

  async readVisibility(): Promise<NetworkVisibility | null> {
    await this.visibilityPending;
    return this.loadVisibility();
  }

  saveVisibility(value: unknown): Promise<void> {
    const visibility = parseVisibility(value);
    const work = this.visibilityPending.then(async () => {
      await this.loadVisibility();
      const temporary = `${this.visibilityFilename}.${randomUUID()}.tmp`;
      let created = false;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, ...visibility }), { flag: "wx", mode: 0o600 });
        created = true;
        await rename(temporary, this.visibilityFilename);
      } catch {
        if (created) await unlink(temporary).catch(() => {});
        throw new Error("GENERAL_PREFERENCES_UNAVAILABLE");
      }
    });
    this.visibilityPending = work.catch(() => {});
    return work;
  }

  async read(): Promise<string[]> {
    await this.pending;
    return this.load();
  }

  private async load(): Promise<string[]> {
    let file;
    try {
      file = await open(this.filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await file.stat();
      if (!info.isFile() || info.size > 4096) throw new Error("GENERAL_PREFERENCES_INVALID");
      const bytes = Buffer.alloc(4097), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 4096) throw new Error("GENERAL_PREFERENCES_INVALID");
      const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).sort().join() !== "mainnets,version" || (value as { version: unknown }).version !== 1)
        throw new Error("GENERAL_PREFERENCES_INVALID");
      return parse((value as { mainnets: unknown }).mainnets);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw new Error("GENERAL_PREFERENCES_UNAVAILABLE");
    } finally { await file?.close(); }
  }

  save(value: unknown): Promise<void> {
    const mainnets = parse(value);
    const work = this.pending.then(async () => {
      await this.load();
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      let created = false;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, mainnets }), { flag: "wx", mode: 0o600 });
        created = true;
        await rename(temporary, this.filename);
      } catch {
        if (created) await unlink(temporary).catch(() => {});
        throw new Error("GENERAL_PREFERENCES_UNAVAILABLE");
      }
    });
    this.pending = work.catch(() => {});
    return work;
  }
}
