import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { GENERAL_NETWORKS, generalTokens } from "@koincode/wallet/general";

export type GeneralCustomAsset = {
  walletId: string; address: string; networkId: string; contractAddress: string;
  name: string | null; symbol: string | null; decimals: number | null;
  decimalsSource: "chain" | "user" | "unknown"; visible: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const MAX_BYTES = 1024 * 1024;
const NETWORKS = new Set(GENERAL_NETWORKS.map((network) => network.id));

function validText(value: unknown, max: number): value is string | null {
  return value === null || typeof value === "string" && Array.from(value).length > 0 && Array.from(value).length <= max &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0)!;
      return code > 31 && !(code >= 127 && code <= 159) && code !== 0x200e && code !== 0x200f &&
        !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2066 && code <= 0x2069);
    });
}

function identity(walletId: unknown, address: unknown, networkId: unknown): asserts walletId is string {
  if (typeof walletId !== "string" || !UUID.test(walletId) || typeof address !== "string" || !ADDRESS.test(address) ||
      typeof networkId !== "string" || !NETWORKS.has(networkId)) throw new Error("GENERAL_ASSET_INVALID");
}

function asset(value: unknown): GeneralCustomAsset {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GENERAL_ASSET_INVALID");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== "address,contractAddress,decimals,decimalsSource,name,networkId,symbol,visible,walletId")
    throw new Error("GENERAL_ASSET_INVALID");
  identity(row.walletId, row.address, row.networkId);
  if (typeof row.contractAddress !== "string" || !ADDRESS.test(row.contractAddress) || /^0x0{40}$/.test(row.contractAddress) ||
      generalTokens(row.networkId as string).some((item) => item.address === row.contractAddress) ||
      !validText(row.name, 128) || !validText(row.symbol, 32) || typeof row.visible !== "boolean" ||
      !(row.decimals === null && row.decimalsSource === "unknown" || Number.isInteger(row.decimals) &&
        (row.decimals as number) >= 0 && (row.decimals as number) <= 255 && (row.decimalsSource === "chain" || row.decimalsSource === "user")))
    throw new Error("GENERAL_ASSET_INVALID");
  return { walletId: row.walletId, address: row.address as string, networkId: row.networkId as string,
    contractAddress: row.contractAddress, name: row.name, symbol: row.symbol, decimals: row.decimals as number | null,
    decimalsSource: row.decimalsSource as GeneralCustomAsset["decimalsSource"], visible: row.visible };
}

function parse(value: unknown): GeneralCustomAsset[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "assets,version" ||
      (value as { version: unknown }).version !== 1 || !Array.isArray((value as { assets: unknown }).assets))
    throw new Error("GENERAL_ASSETS_UNAVAILABLE");
  const rows = (value as { assets: unknown[] }).assets.map(asset), counts = new Map<string, number>(), seen = new Set<string>();
  for (const row of rows) {
    const group = JSON.stringify([row.walletId, row.address, row.networkId]);
    const key = JSON.stringify([row.walletId, row.address, row.networkId, row.contractAddress]);
    const count = (counts.get(group) ?? 0) + 1;
    if (seen.has(key) || count + 1 + generalTokens(row.networkId).length > 100) throw new Error("GENERAL_ASSETS_UNAVAILABLE");
    seen.add(key); counts.set(group, count);
  }
  return rows;
}

/** Display-only state owned by the desktop wallet; it never opens the legacy payment store. */
export class DesktopGeneralWalletAssets {
  private readonly filename: string;
  private pending: Promise<void> = Promise.resolve();
  private revision = 0;
  constructor(directory: string) { this.filename = join(directory, "general-wallet-assets-v1.json"); }

  generation(): number { return this.revision; }

  async list(input: { walletId: string; address: string; networkId: string; offset: number }): Promise<{ assets: GeneralCustomAsset[]; total: number; generation: number }> {
    identity(input.walletId, input.address, input.networkId);
    if (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > 100) throw new Error("GENERAL_ASSET_INVALID");
    await this.pending;
    const generation = this.revision;
    const rows = (await this.read()).filter((item) => item.walletId === input.walletId && item.address === input.address && item.networkId === input.networkId);
    if (generation !== this.revision) throw new Error("GENERAL_STATE_CHANGED");
    return { assets: rows.slice(input.offset, input.offset + 20), total: rows.length, generation };
  }

  async find(input: { walletId: string; address: string; networkId: string; contractAddress: string }): Promise<{ asset: GeneralCustomAsset | undefined; generation: number }> {
    identity(input.walletId, input.address, input.networkId);
    if (typeof input.contractAddress !== "string" || !ADDRESS.test(input.contractAddress)) throw new Error("GENERAL_ASSET_INVALID");
    await this.pending;
    const generation = this.revision;
    const found = (await this.read()).find((item) => item.walletId === input.walletId && item.address === input.address &&
      item.networkId === input.networkId && item.contractAddress === input.contractAddress);
    if (generation !== this.revision) throw new Error("GENERAL_STATE_CHANGED");
    return { asset: found, generation };
  }

  async visible(input: { walletId: string; address: string; networkId: string }): Promise<{ assets: GeneralCustomAsset[]; generation: number }> {
    identity(input.walletId, input.address, input.networkId);
    await this.pending;
    const generation = this.revision;
    const selected = (await this.read()).filter((item) => item.walletId === input.walletId && item.address === input.address &&
      item.networkId === input.networkId && item.visible);
    if (generation !== this.revision) throw new Error("GENERAL_STATE_CHANGED");
    return { assets: selected, generation };
  }

  add(value: GeneralCustomAsset): Promise<void> {
    const candidate = asset(value);
    return this.mutate((rows) => {
      const same = rows.filter((item) => item.walletId === candidate.walletId && item.address === candidate.address && item.networkId === candidate.networkId);
      if (same.some((item) => item.contractAddress === candidate.contractAddress)) throw new Error("GENERAL_ASSET_EXISTS");
      if (same.length + 1 + generalTokens(candidate.networkId).length >= 100) throw new Error("GENERAL_ASSET_LIMIT");
      rows.push(candidate);
    });
  }

  setVisibility(input: { walletId: string; address: string; networkId: string; contractAddress: string; visible: boolean }): Promise<void> {
    identity(input.walletId, input.address, input.networkId);
    if (typeof input.contractAddress !== "string" || !ADDRESS.test(input.contractAddress) || typeof input.visible !== "boolean")
      throw new Error("GENERAL_ASSET_INVALID");
    return this.mutate((rows) => {
      const row = rows.find((item) => item.walletId === input.walletId && item.address === input.address &&
        item.networkId === input.networkId && item.contractAddress === input.contractAddress);
      if (!row) throw new Error("GENERAL_ASSET_NOT_FOUND");
      row.visible = input.visible;
    });
  }

  private async read(): Promise<GeneralCustomAsset[]> {
    let file;
    try {
      file = await open(this.filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Invalid asset store");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > MAX_BYTES) throw new Error("Invalid asset store");
      return parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw new Error("GENERAL_ASSETS_UNAVAILABLE");
    } finally { await file?.close(); }
  }

  private mutate(change: (rows: GeneralCustomAsset[]) => void): Promise<void> {
    const work = this.pending.then(async () => {
      const rows = await this.read();
      change(rows);
      const contents = Buffer.from(JSON.stringify({ version: 1, assets: rows }));
      if (contents.length > MAX_BYTES) throw new Error("GENERAL_ASSET_LIMIT");
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      let file, created = false;
      try {
        file = await open(temporary, "wx", 0o600); created = true;
        await file.writeFile(contents); await file.sync(); await file.close(); file = undefined;
        await rename(temporary, this.filename); created = false; this.revision++;
      } catch {
        await file?.close().catch(() => {});
        if (created) await unlink(temporary).catch(() => {});
        throw new Error("GENERAL_ASSETS_UNAVAILABLE");
      }
    });
    this.pending = work.catch(() => {});
    return work;
  }
}
