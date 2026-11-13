import { app } from "electron";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
const addressPattern = /^0x[0-9a-f]{40}$/;
let pending: Promise<void> = Promise.resolve();
export function walletAccountName(value: unknown): string {
  if (typeof value !== "string") throw new Error("WALLET_NAME_INVALID");
  const name = value.trim();
  if ([...name].length > 40 || Buffer.byteLength(name) > 160 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new Error("WALLET_NAME_INVALID");
  return name;
}
async function load(): Promise<Record<string, string>> {
  let file;
  try {
    file = await open(join(app.getPath("userData"), "wallet-account-names-v1.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await file.stat();
    if (!info.isFile() || info.size > 256 * 1024) throw new Error("WALLET_NAMES_UNAVAILABLE");
    const bytes = Buffer.alloc(256 * 1024 + 1), read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > 256 * 1024) throw new Error("WALLET_NAMES_UNAVAILABLE");
    const data = JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8"));
    if (!data || Object.keys(data).sort().join() !== "names,version" || data.version !== 1 ||
      !data.names || typeof data.names !== "object" || Array.isArray(data.names) || Object.keys(data.names).length > 1024)
      throw new Error("WALLET_NAMES_UNAVAILABLE");
    for (const [address, name] of Object.entries(data.names))
      if (!addressPattern.test(address) || walletAccountName(name) !== name) throw new Error("WALLET_NAMES_UNAVAILABLE");
    return data.names;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw new Error("WALLET_NAMES_UNAVAILABLE");
  } finally { await file?.close(); }
}
export async function readWalletAccountNames(): Promise<Record<string, string>> { await pending; return load(); }
export function renameWalletAccount(address: string, value: unknown, current: () => void): Promise<void> {
  const name = walletAccountName(value);
  if (!addressPattern.test(address)) return Promise.reject(new Error("WALLET_NAME_INVALID"));
  const work = pending.then(async () => {
    current(); const names = await load(); current();
    if (name) names[address] = name; else delete names[address];
    if (Object.keys(names).length > 1024) throw new Error("WALLET_NAMES_UNAVAILABLE");
    const filename = join(app.getPath("userData"), "wallet-account-names-v1.json"), temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, names }), { flag: "wx", mode: 0o600 });
      current(); await rename(temporary, filename);
    } finally { await unlink(temporary).catch(() => {}); }
  });
  pending = work.catch(() => {}); return work;
}
/** Adds display-only aliases after the original protected session has checked ownership. */
export async function dispatchNamedSetup(command: unknown, dispatch: (value: unknown) => Promise<unknown>, current: () => void): Promise<unknown> {
  const input = command as { action?: string; sourceId?: string; name?: unknown };
  if (input?.action === "rename_account") {
    if (Object.keys(input).sort().join() !== "action,name,sourceId") throw new Error("INVALID_REQUEST");
    const status = await dispatch({ action: "status" }) as { accounts: Array<{ sourceId: string; address: string }> };
    current(); const account = status.accounts.find(item => item.sourceId === input.sourceId);
    if (!account) throw new Error("GENERAL_ACCOUNT_UNAVAILABLE");
    await renameWalletAccount(account.address.toLowerCase(), input.name, current); current(); return null;
  }
  const value = await dispatch(command);
  if (input?.action !== "status") return value;
  const names = await readWalletAccountNames().catch(() => ({} as Record<string, string>)); current();
  const status = value as { accounts: Array<{ address: string }> };
  return { ...status, accounts: status.accounts.map(account => ({ ...account, name: names[account.address.toLowerCase()] ?? "" })) };
}
