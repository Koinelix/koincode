import { Interface, Transaction, type Wallet, type HDNodeWallet } from "ethers";
import { atomic } from "./atomic.js";
import { networkConfig } from "./networks.js";
import { PERMIT2_ADDRESS } from "./uptoAuthorization.js";
import { requireWallet } from "./errors.js";
import type { Network } from "./model.js";

export interface AllowanceTransaction {
  network: Network; payer: string; amountAtomic: string; nonce: number; gasLimit: string; gasPrice: string;
}
const abi = new Interface(["function approve(address spender,uint256 amount) returns(bool)"]);
export function allowanceData(amountAtomic: string): string {
  const amount = atomic(amountAtomic);
  requireWallet(amount < (1n << 256n) - 1n, "INVALID_AMOUNT", "Enter a finite allowance.");
  return abi.encodeFunctionData("approve", [PERMIT2_ADDRESS, amount]);
}
export function allowanceTransaction(input: AllowanceTransaction) {
  const network = networkConfig(input.network);
  requireWallet(/^0x[0-9a-f]{40}$/.test(input.payer) && Number.isSafeInteger(input.nonce) && input.nonce >= 0 &&
    atomic(input.gasLimit) > 0n && atomic(input.gasPrice) > 0n, "INVALID_REQUEST", "Invalid approval transaction.");
  return { chainId: network.chainId, type: 0, nonce: input.nonce, value: 0n, to: network.asset,
    data: allowanceData(input.amountAtomic), gasLimit: BigInt(input.gasLimit), gasPrice: BigInt(input.gasPrice) };
}
export async function signAllowance(account: Wallet | HDNodeWallet, intent: AllowanceTransaction) {
  requireWallet(account.address.toLowerCase() === intent.payer, "PERMIT_MISMATCH", "The selected account changed.");
  return account.signTransaction(allowanceTransaction(intent));
}
export function verifySignedAllowance(raw: string, intent: AllowanceTransaction) {
  const tx = Transaction.from(raw);
  requireWallet(tx.from?.toLowerCase() === intent.payer && tx.hash &&
    tx.unsignedSerialized === Transaction.from(allowanceTransaction(intent)).unsignedSerialized,
  "PERMIT_MISMATCH", "The signed approval differs from the confirmed terms.");
  return tx.hash.toLowerCase();
}
