import { createPublicClient, http, encodeFunctionData, parseAbi } from "viem";
import { base, baseSepolia } from "viem/chains";
import { networkConfig } from "../domain/networks.js";
import { allowanceData, allowanceTransaction, type AllowanceTransaction } from "../domain/allowanceTransaction.js";
import type { Network } from "../domain/model.js";
import { requireWallet } from "../domain/errors.js";
import { Transaction, getBytes } from "ethers";

async function clientFor(network: Network, signal: AbortSignal) {
  const config = networkConfig(network);
  const client = createPublicClient({ chain: network === "eip155:8453" ? base : baseSepolia,
    transport: http(config.endpoint, { retryCount: 0, timeout: 12000, fetchOptions: { signal, redirect: "error" } }) });
  requireWallet(await client.getChainId() === config.chainId, "PAYMENT_NETWORK_MISMATCH", "RPC chain ID mismatch.");
  return client;
}
export const allowanceRpc = {
  async quote(network: Network, payer: string, amount: string, signal: AbortSignal) {
    const client = await clientFor(network, signal), account = payer as `0x${string}`, to = networkConfig(network).asset;
    const data = allowanceData(amount) as `0x${string}`;
    const balance = await client.getBalance({ address: account });
    requireWallet(balance > 0n, "ALLOWANCE_GAS_REQUIRED", "The selected account needs ETH for the Base network fee.");
    const [nonce, latestNonce, gas, price, simulation] = await Promise.all([
      client.getTransactionCount({ address: account, blockTag: "pending" }), client.getTransactionCount({ address: account, blockTag: "latest" }),
      client.estimateGas({ account, to, data }), client.getGasPrice(), client.call({ account, to, data }),
    ]);
    requireWallet(nonce === latestNonce, "ALLOWANCE_TX_PENDING", "An account transaction is pending.");
    requireWallet(simulation.data && BigInt(simulation.data) === 1n, "ALLOWANCE_APPROVAL_FAILED", "USDC did not accept the approval.");
    const tx: AllowanceTransaction = { network, payer, amountAtomic: amount, nonce, gasLimit: ((gas * 12n + 9n) / 10n).toString(), gasPrice: price.toString() };
    const bytes = getBytes(Transaction.from(allowanceTransaction(tx)).unsignedSerialized).length;
    const l1 = await client.call({ to: "0x420000000000000000000000000000000000000F", data: encodeFunctionData({
      abi: parseAbi(["function getL1FeeUpperBound(uint256 unsignedTxSize) view returns(uint256)"]), functionName: "getL1FeeUpperBound", args: [BigInt(bytes)] }) });
    requireWallet(l1.data?.length === 66, "ALLOWANCE_FEE_UNAVAILABLE", "The Base data fee is unavailable.");
    const operator = await client.readContract({ address: "0x420000000000000000000000000000000000000F",
      abi: parseAbi(["function getOperatorFee(uint256 gasUsed) view returns(uint256)"]), functionName: "getOperatorFee", args: [BigInt(tx.gasLimit)] });
    const feeWei = (BigInt(tx.gasLimit) * price + BigInt(l1.data) + operator).toString();
    return { tx, feeWei, hasGas: balance >= BigInt(feeWei) };
  },
  async finalizedNonce(network: Network, payer: string, signal: AbortSignal) {
    return (await clientFor(network, signal)).getTransactionCount({ address: payer as `0x${string}`, blockTag: "finalized" });
  },
  async broadcast(network: Network, raw: string, signal: AbortSignal) {
    const client = await clientFor(network, signal);
    signal.throwIfAborted();
    return client.sendRawTransaction({ serializedTransaction: raw as `0x${string}` });
  },
};
