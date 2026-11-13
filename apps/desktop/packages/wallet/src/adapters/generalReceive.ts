import { getAddress } from "ethers";
import { create as makeQr } from "qrcode/lib/core/qrcode.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { generalTokens } from "../domain/generalTokens.js";
import { WalletError, requireWallet } from "../domain/errors.js";

/** Address-only QR; no RPC, transaction, EIP-681 request, or payment capability. */
export function createGeneralReceiveView(input: { networkId: string; address: string; assetId: string }) {
  const network = generalNetwork(input.networkId);
  requireWallet(typeof input.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(input.address),
    "INVALID_ADDRESS", "A valid receiving address is required.");
  let address: string;
  try { address = getAddress(input.address); }
  catch { throw new WalletError("INVALID_ADDRESS", "A valid receiving address is required."); }
  requireWallet(!/^0x0{40}$/i.test(address), "INVALID_ADDRESS", "The zero address is not allowed.");
  const tokens = generalTokens(network.id);
  const token = tokens.find((item) => `erc20:${item.address}` === input.assetId);
  requireWallet(input.assetId === "native" || token, "INVALID_ASSET", "The receiving asset is not available on this network.");
  const matrix = makeQr(address, { errorCorrectionLevel: "M" }).modules;
  requireWallet(Number.isSafeInteger(matrix.size) && matrix.size >= 21 && matrix.size <= 57 &&
    matrix.data.length === matrix.size * matrix.size && matrix.data.every((value) => value === 0 || value === 1),
  "GENERAL_RECEIVE_UNAVAILABLE", "The receiving code is unavailable.");
  return { networkId: network.id, chainId: String(network.chainId), address, assetId: input.assetId,
    asset: token ? { symbol: token.symbol, contractAddress: token.address, decimals: token.decimals }
      : { symbol: network.nativeSymbol, contractAddress: null, decimals: 18 },
    qr: { size: matrix.size, modules: Array.from(matrix.data).join("") } };
}
