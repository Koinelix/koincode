import { z } from "zod";
import type { GeneralSigningRisk } from "../app/generalSigningTypes.js";
import { positiveAtomic } from "../domain/atomic.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { assertGeneralSigningNetwork } from "../domain/generalSigningPolicy.js";

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const integer = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
export const generalSigningRiskSchema = z.strictObject({
  riskId: id, transferId: id, intentDigest: hash, accountAddress: address,
  networkId: z.string().regex(/^eip155:[1-9][0-9]{0,19}$/), nonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  asset: z.union([z.literal("native"), z.string().regex(/^erc20:0x[0-9a-f]{40}$/)]),
  amountAtomic: integer, maxGasAtomic: integer,
  approvalExpiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export function parseGeneralSigningRisk(value: unknown, historical = false): GeneralSigningRisk {
  const result = generalSigningRiskSchema.safeParse(value);
  if (!result.success) throw new WalletError("SIGNING_CONTINUITY_UNKNOWN", "General wallet signing continuity cannot be verified.");
  const risk = result.data, network = generalNetwork(risk.networkId);
  if (historical) requireWallet(network.id !== "eip155:84532", "SIGNING_CONTINUITY_UNKNOWN", "The archived signing network was reserved.");
  else assertGeneralSigningNetwork(network.id, BigInt(network.chainId));
  positiveAtomic(risk.amountAtomic); positiveAtomic(risk.maxGasAtomic);
  requireWallet(!/^0x0{40}$/.test(risk.accountAddress) && (risk.asset === "native" || !/^erc20:0x0{40}$/.test(risk.asset)),
    "SIGNING_CONTINUITY_UNKNOWN", "The signing risk identity is invalid.");
  return risk;
}
