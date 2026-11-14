/** Prices come from the service quote. A model-generated amount here can block an authorized purchase. */
export const walletClientTool = {
  name: "wallet_run_client",
  description: "Run the selected independent client with its script, runtime and business arguments. The wallet handles service quotes using its existing authorizations and limits. Honor any explicit spending restriction and stop if the selected client cannot enforce it. Display result artifacts using their returned URIs.",
  inputSchema: {
    type: "object",
    properties: {
      script: { type: "string", maxLength: 8192 },
      runtime: { enum: ["python3", "node"] },
      args: { type: "array", items: { type: "string", maxLength: 8192 }, maxItems: 64 },
    },
    required: ["script", "runtime"],
    additionalProperties: false,
  },
} as const;
