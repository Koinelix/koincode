import type { GeneralBalanceRpc } from "./generalBalances.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { generalNetwork } from "../domain/generalNetworks.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

export interface GeneralTokenInspection {
  networkId: string;
  address: string;
  contractAddress: string;
  blockNumber: string;
  blockHash: string;
  balanceAtomic: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
}

function canceled(): WalletError {
  return new WalletError("BALANCE_READ_CANCELED", "Token inspection was canceled or timed out.");
}

async function call(rpc: GeneralBalanceRpc, method: string, params: readonly unknown[], signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw canceled();
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  let onAbort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(canceled());
    bounded.addEventListener("abort", onAbort, { once: true });
    if (bounded.aborted) onAbort();
  });
  try { return await Promise.race([rpc.call(method, params, bounded), stopped]); }
  finally { bounded.removeEventListener("abort", onAbort); }
}

function block(value: unknown): { number: string; hash: string } {
  requireWallet(value !== null && typeof value === "object" && !Array.isArray(value), "TOKEN_INSPECTION_INVALID", "Invalid block.");
  const row = value as Record<string, unknown>;
  requireWallet(typeof row.number === "string" && QUANTITY.test(row.number) && typeof row.hash === "string" && HASH.test(row.hash),
    "TOKEN_INSPECTION_INVALID", "Invalid block identity.");
  return { number: row.number.toLowerCase(), hash: row.hash.toLowerCase() };
}

/** Accept bounded ABI strings and common legacy bytes32 metadata, never arbitrary remote resources. */
function metadata(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value) || value.length > 8194) return null;
  const bytes = Buffer.from(value.slice(2), "hex");
  let textBytes: Buffer;
  if (bytes.length === 32) {
    const end = bytes.indexOf(0);
    textBytes = bytes.subarray(0, end < 0 ? bytes.length : end);
  } else {
    if (bytes.length < 64 || bytes.length % 32 !== 0 || BigInt(`0x${bytes.subarray(0, 32).toString("hex")}`) !== 32n) return null;
    const length = BigInt(`0x${bytes.subarray(32, 64).toString("hex")}`);
    if (length > 2048n || 64 + Number(length) > bytes.length || bytes.length !== 64 + Math.ceil(Number(length) / 32) * 32) return null;
    textBytes = bytes.subarray(64, 64 + Number(length));
    if (bytes.subarray(64 + Number(length)).some((byte) => byte !== 0)) return null;
  }
  try {
    const decoded = Array.from(new TextDecoder("utf-8", { fatal: true }).decode(textBytes)).filter((character) => {
      const code = character.codePointAt(0)!;
      return code > 31 && !(code >= 127 && code <= 159) && code !== 0x200e && code !== 0x200f &&
        !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2066 && code <= 0x2069);
    }).join("").trim();
    return Array.from(decoded).slice(0, maximum).join("") || null;
  } catch { return null; }
}

/** Read-only inspection. The caller owns scheduling and must discard results after its account or network changes. */
export async function inspectGeneralToken(input: {
  networkId: string; address: string; contractAddress: string; rpc: GeneralBalanceRpc; signal?: AbortSignal;
}): Promise<GeneralTokenInspection> {
  const network = generalNetwork(input.networkId);
  requireWallet(typeof input.address === "string" && ADDRESS.test(input.address) &&
    typeof input.contractAddress === "string" && ADDRESS.test(input.contractAddress) && !/^0x0{40}$/i.test(input.contractAddress),
  "INVALID_ASSET", "Invalid token or account address.");
  const address = input.address.toLowerCase(), contractAddress = input.contractAddress.toLowerCase();
  const deadline = AbortSignal.timeout(20000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const chain = await call(input.rpc, "eth_chainId", [], signal);
  requireWallet(typeof chain === "string" && QUANTITY.test(chain) && BigInt(chain) === BigInt(network.chainId),
    "RPC_CHAIN_MISMATCH", "The RPC returned a different network.");
  const initial = block(await call(input.rpc, "eth_getBlockByNumber", ["latest", false], signal));
  const code = await call(input.rpc, "eth_getCode", [contractAddress, initial.number], signal);
  requireWallet(typeof code === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(code) && code.length <= 49154,
    "TOKEN_CONTRACT_UNAVAILABLE", "The token contract is unavailable.");
  const balance = await call(input.rpc, "eth_call", [{ to: contractAddress, data: `0x70a08231${address.slice(2).padStart(64, "0")}` }, initial.number], signal);
  requireWallet(typeof balance === "string" && WORD.test(balance), "TOKEN_BALANCE_UNAVAILABLE", "The token balance is unavailable.");
  const optional = async (selector: string): Promise<unknown> => {
    try { return await call(input.rpc, "eth_call", [{ to: contractAddress, data: selector }, initial.number], signal); }
    catch { if (signal.aborted) throw canceled(); return null; }
  };
  const [rawName, rawSymbol, rawDecimals] = await Promise.all([optional("0x06fdde03"), optional("0x95d89b41"), optional("0x313ce567")]);
  const decimalsValue = typeof rawDecimals === "string" && WORD.test(rawDecimals) ? BigInt(rawDecimals) : null;
  const final = block(await call(input.rpc, "eth_getBlockByNumber", [initial.number, false], signal));
  const finalChain = await call(input.rpc, "eth_chainId", [], signal);
  requireWallet(final.number === initial.number && final.hash === initial.hash && typeof finalChain === "string" &&
    QUANTITY.test(finalChain) && BigInt(finalChain) === BigInt(network.chainId), "TOKEN_INSPECTION_STALE", "The network or block changed.");
  if (signal.aborted) throw canceled();
  return { networkId: network.id, address, contractAddress, blockNumber: BigInt(initial.number).toString(), blockHash: initial.hash,
    balanceAtomic: BigInt(balance).toString(), name: metadata(rawName, 128), symbol: metadata(rawSymbol, 32),
    decimals: decimalsValue !== null && decimalsValue <= 255n ? Number(decimalsValue) : null };
}
