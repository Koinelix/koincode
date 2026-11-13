import type { ChainBlock } from "../app/ports.js";
import { requireWallet } from "../domain/errors.js";
export function chainHeight(value: unknown): number {
  requireWallet(
    typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) && value.length <= 18,
    "RPC_EVIDENCE_INVALID",
    "A bounded RPC block quantity is required.",
  );
  const parsed = Number(BigInt(value));
  requireWallet(
    Number.isSafeInteger(parsed) && parsed >= 0,
    "RPC_EVIDENCE_INVALID",
    "The RPC block quantity is invalid.",
  );
  return parsed;
}
export function chainBlock(value: unknown): ChainBlock {
  requireWallet(
    value && typeof value === "object",
    "RPC_EVIDENCE_INVALID",
    "The RPC block is missing.",
  );
  const block = value as Record<string, unknown>;
  requireWallet(
    typeof block.hash === "string" && /^0x[0-9a-f]{64}$/i.test(block.hash),
    "RPC_EVIDENCE_INVALID",
    "The RPC block hash is invalid.",
  );
  return {
    number: chainHeight(block.number),
    hash: block.hash.toLowerCase(),
    timestamp: chainHeight(block.timestamp),
  };
}
