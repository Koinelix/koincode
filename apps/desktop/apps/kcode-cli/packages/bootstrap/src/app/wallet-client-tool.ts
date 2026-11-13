import { z } from "zod";
import { walletClientPaymentLimitSchema } from "@fcode/shared";

/** Official host integration only. The wallet itself neither launches scripts nor owns merchant execution. */
export const walletClientTool = {
  name: "wallet_run_client",
  description: "Run an explicitly selected independent client script with a private authenticated wallet connection. The script owns its business HTTP and result processing. Running it grants no payment authority: existing wallet authorizations and limits apply. Omit paymentLimit unless the user specified an additional spending ceiling; never invent a zero ceiling. Never put secrets in arguments. Result artifacts can be displayed using their returned URIs.",
  inputSchema: {
    type: "object",
    properties: {
      script: { type: "string", maxLength: 8192 },
      runtime: { enum: ["python3", "node"] },
      args: { type: "array", items: { type: "string", maxLength: 8192 }, maxItems: 64 },
      paymentLimit: { ...z.toJSONSchema(walletClientPaymentLimitSchema, { target: "draft-7" }),
        description: "Optional stricter ceiling explicitly requested by the user for each payment in this invocation. Omit this entire property when no additional user ceiling was specified; it has no zero default. Match the actual EVM network and token address; maxAmountAtomic is an integer in that token's smallest units (USDC has 6 decimals). An explicit zero forbids positive payments; zero never means unlimited. This cannot raise wallet limits or create a wallet authorization." },
    },
    required: ["script", "runtime"],
    additionalProperties: false,
  },
} as const;
