const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/, HEAD = /^[0-9a-f]{64}$/, HASH = /^0x[0-9a-f]{64}$/;
const NETWORKS = new Set(["1", "11155111", "8453", "84532", "42161", "421614", "10", "11155420", "56", "97", "137", "80002", "43114", "43113"].map((chain) => `eip155:${chain}`));
const valid = (ok: boolean): void => { if (!ok) throw new Error("GENERAL_SETUP_REPLY_INVALID"); };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  valid(!!value && typeof value === "object" && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  valid(Object.keys(row).sort().join() === [...keys].sort().join()); return row;
}
const matches = (value: unknown, pattern: RegExp) => typeof value === "string" && pattern.test(value);
function positive(value: unknown): boolean {
  try { return typeof value === "string" && /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) < (1n << 256n); } catch { return false; }
}

/** This is a display contract, never transaction evidence or a source of payment authority. */
export function assertGeneralHistoryReply(value: unknown): void {
  const row = object(value, ["sourceId", "accountAddress", "networkId", "status", "items", "head", "nextOffset"]);
  valid(matches(row.sourceId, UUID) && matches(row.accountAddress, ADDRESS) && typeof row.networkId === "string" && NETWORKS.has(row.networkId) &&
    Array.isArray(row.items) && row.items.length <= 20 && (row.status === "ready" || row.status === "unregistered"));
  if (row.status === "unregistered") { valid(row.head === null && row.nextOffset === null && (row.items as unknown[]).length === 0); return; }
  valid(matches(row.head, HEAD) && (row.nextOffset === null || Number.isSafeInteger(row.nextOffset) && (row.nextOffset as number) > 0 && (row.nextOffset as number) <= 1000));
  const seen = new Set<unknown>();
  for (const value of row.items as unknown[]) {
    const item = object(value, ["riskId", "transferId", "accountAddress", "networkId", "asset", "decimals", "recipient", "amountAtomic", "maxFeeAtomic", "createdAt", "riskRetained", "phase", "material", "broadcast", "transactionHash"]);
    valid(matches(item.riskId, UUID) && matches(item.transferId, UUID) && !seen.has(item.riskId) && item.accountAddress === row.accountAddress && item.networkId === row.networkId &&
      (item.asset === "native" || typeof item.asset === "string" && /^erc20:0x[0-9a-f]{40}$/.test(item.asset)) &&
      (item.asset === "native" ? item.decimals === 18 : item.decimals === null || Number.isInteger(item.decimals) && (item.decimals as number) >= 0 && (item.decimals as number) <= 255) &&
      (item.recipient === null || matches(item.recipient, ADDRESS)) && positive(item.amountAtomic) && positive(item.maxFeeAtomic) &&
      item.createdAt === null && item.riskRetained === true && ["SIGNING_POSSIBLE", "SIGNED"].includes(item.phase as string) &&
      ["available", "unavailable", "conflict"].includes(item.material as string) &&
      ["BROADCAST_POSSIBLE", "SUBMITTED", "UNKNOWN", "no_record", "unavailable"].includes(item.broadcast as string) &&
      (item.transactionHash === null || matches(item.transactionHash, HASH)) &&
      (item.material !== "available" || item.transactionHash !== null) && (item.material !== "conflict" || item.transactionHash === null));
    seen.add(item.riskId);
  }
}
