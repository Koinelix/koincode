import { generalRpcChoices } from "@koincode/wallet/general";

/** Dedicated private control protocol. No secret or payment command is accepted here. */
export type GeneralWalletAction = "status" | "networks";
export type GeneralWalletRequest = { type: "start"; id: string } | { type: "status"; id: string } | { type: "networks"; id: string }
  | { type: "cancel"; id: string }
  | { type: "probe_rpc"; id: string; networkId: string; rpcChoice: string }
  | { type: "balances"; id: string; networkId: string; address: string; cacheScope: string; rpcChoice?: string }
  | { type: "custom_balances"; id: string; networkId: string; address: string; cacheScope: string;
      assets: Array<{ contractAddress: string; expectedDecimals?: number }>; rpcChoice?: string }
  | { type: "inspect_token"; id: string; networkId: string; address: string; contractAddress: string; rpcChoice?: string }
  | { type: "receive"; id: string; networkId: string; address: string; assetId: string };
export type GeneralWalletReply =
  | { type: "reply"; id: string; ok: true; value: unknown }
  | { type: "reply"; id: string; ok: false; code: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validChoice(networkId: unknown, choice: unknown): boolean {
  if (typeof networkId !== "string" || typeof choice !== "string") return false;
  try { return generalRpcChoices(networkId).some((candidate) => candidate.id === choice); } catch { return false; }
}

export function parseGeneralWalletRequest(value: unknown): GeneralWalletRequest | null {
  if (!record(value) || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id)) return null;
  const keys = Object.keys(value).sort().join();
  if (keys === "id,networkId,rpcChoice,type" && value.type === "probe_rpc" && validChoice(value.networkId, value.rpcChoice))
    return value as GeneralWalletRequest;
  if ((keys === "address,assets,cacheScope,id,networkId,type" || keys === "address,assets,cacheScope,id,networkId,rpcChoice,type" &&
      validChoice(value.networkId, value.rpcChoice)) && value.type === "custom_balances" &&
      typeof value.networkId === "string" && /^eip155:[1-9][0-9]{0,19}$/.test(value.networkId) &&
      typeof value.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.address) &&
      typeof value.cacheScope === "string" && /^[0-9a-f]{64}$/.test(value.cacheScope) &&
      Array.isArray(value.assets) && value.assets.length >= 1 && value.assets.length <= 20 &&
      value.assets.every((asset: unknown) => record(asset) &&
        (Object.keys(asset).sort().join() === "contractAddress" || Object.keys(asset).sort().join() === "contractAddress,expectedDecimals") &&
        typeof asset.contractAddress === "string" && /^0x[0-9a-f]{40}$/.test(asset.contractAddress) && !/^0x0{40}$/.test(asset.contractAddress) &&
        (asset.expectedDecimals === undefined || Number.isInteger(asset.expectedDecimals) && (asset.expectedDecimals as number) >= 0 && (asset.expectedDecimals as number) <= 255)) &&
      new Set(value.assets.map((asset: { contractAddress: string }) => asset.contractAddress)).size === value.assets.length)
    return value as GeneralWalletRequest;
  if ((keys === "address,contractAddress,id,networkId,type" || keys === "address,contractAddress,id,networkId,rpcChoice,type" &&
      validChoice(value.networkId, value.rpcChoice)) && value.type === "inspect_token" &&
      typeof value.networkId === "string" && /^eip155:[1-9][0-9]{0,19}$/.test(value.networkId) &&
      typeof value.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.address) &&
      typeof value.contractAddress === "string" && /^0x[0-9a-f]{40}$/.test(value.contractAddress) &&
      !/^0x0{40}$/.test(value.contractAddress)) return value as GeneralWalletRequest;
  if (keys === "address,assetId,id,networkId,type" && value.type === "receive" &&
      typeof value.networkId === "string" && /^eip155:[1-9][0-9]{0,19}$/.test(value.networkId) &&
      typeof value.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.address) &&
      typeof value.assetId === "string" && /^(?:native|erc20:0x[0-9a-f]{40})$/.test(value.assetId)) return value as GeneralWalletRequest;
  if ((keys === "address,cacheScope,id,networkId,type" || keys === "address,cacheScope,id,networkId,rpcChoice,type" &&
      validChoice(value.networkId, value.rpcChoice)) && value.type === "balances" &&
      typeof value.networkId === "string" && /^eip155:[1-9][0-9]{0,19}$/.test(value.networkId) &&
      typeof value.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.address) &&
      typeof value.cacheScope === "string" && /^[0-9a-f]{64}$/.test(value.cacheScope)) return value as GeneralWalletRequest;
  if (keys !== "id,type" || (value.type !== "start" && value.type !== "status" && value.type !== "networks" && value.type !== "cancel")) return null;
  return value as GeneralWalletRequest;
}

export function parseGeneralWalletReply(value: unknown): GeneralWalletReply | null {
  if (!record(value) || value.type !== "reply" || typeof value.id !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.id) || typeof value.ok !== "boolean") return null;
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) return null;
  } catch { return null; }
  if (value.ok === true && Object.keys(value).sort().join() === "id,ok,type,value") return value as GeneralWalletReply;
  if (value.ok === false && Object.keys(value).sort().join() === "code,id,ok,type" &&
      typeof value.code === "string" && /^GENERAL_[A-Z0-9_]{1,70}$/.test(value.code)) return value as GeneralWalletReply;
  return null;
}
