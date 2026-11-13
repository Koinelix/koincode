import { GeneralRpcTransport } from "./generalRpcTransport.js";
import { generalRpcEndpoint } from "./generalRpcEndpoints.js";
import { takeGeneralBroadcastResult } from "./generalTransferSigner.js";

/** Initial send only; a timeout is unknown and never triggers an automatic retry. */
export async function broadcastGeneralTransfer(result: object, signal: AbortSignal, transport?: GeneralRpcTransport): Promise<{
  status: "SUBMITTED" | "UNKNOWN"; transactionHash: string;
}> {
  const binding = takeGeneralBroadcastResult(result);
  const stored = await binding.material.beginBroadcast(binding.preview, binding.digest, binding.riskId);
  const rpc = transport ?? new GeneralRpcTransport(generalRpcEndpoint(binding.preview.networkId), undefined, "broadcast");
  let outcome: { status: "SUBMITTED" | "UNKNOWN"; transactionHash: string };
  try { outcome = await rpc.sendSigned(binding.permit, binding.preview, binding.riskId, stored.signedTransaction, signal); }
  catch { outcome = { status: "UNKNOWN", transactionHash: stored.transactionHash }; }
  if (outcome.transactionHash !== stored.transactionHash || (outcome.status !== "SUBMITTED" && outcome.status !== "UNKNOWN"))
    outcome = { status: "UNKNOWN", transactionHash: stored.transactionHash };
  try { await binding.material.finishBroadcast(binding.preview, binding.digest, binding.riskId, stored.transactionHash, outcome.status); }
  catch { return { status: "UNKNOWN", transactionHash: stored.transactionHash }; }
  return outcome;
}
