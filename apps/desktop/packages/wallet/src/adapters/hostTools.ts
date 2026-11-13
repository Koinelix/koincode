const strings = (names: string[]) =>
  Object.fromEntries(names.map((n) => [n, { type: "string", maxLength: 150 }]));
const requestSchema = {
  type: "object",
  properties: {
    url: { type: "string", maxLength: 8192 },
    method: { enum: ["GET", "POST"] },
    headers: { type: "object", additionalProperties: { type: "string" } },
    bodyJson: {},
    bodyRef: { type: "string" },
    credentialRef: { type: "string" },
    idempotency: {
      type: "object",
      properties: { headerName: { type: "string" } },
      required: ["headerName"],
      additionalProperties: false,
    },
    paymentMode: { enum: ["policy", "never"] },
    responseMode: { enum: ["opaque", "image"], description: "Host result delivery; defaults to opaque." },
    requestContextRef: { type: "string" },
    requestContextAction: { enum: ["recover", "refresh_quote"] },
  },
  additionalProperties: false,
} as const;
export const walletMcpTools = [
  {
    name: "wallet_get_capabilities",
    description:
      "Read supported x402 transport and result capabilities. This grants no payment authority.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wallet_get_info",
    description: "Read wallet and budget state visible to this authenticated client.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "x402_request",
    description:
      "Send a host-authorized HTTP operation. Requires a durable operation UUID in trusted call metadata; never mode cannot pay.",
    inputSchema: requestSchema,
  },
  ...[
    ["x402_get_request", "Read local request facts without sending merchant HTTP."],
    ["x402_reconcile", "Verify chain facts without new payment or merchant HTTP."],
    [
      "x402_recover_response",
      "Recheck an existing protected response without merchant HTTP or signing. Unavailable data never authorizes another purchase.",
    ],
    [
      "x402_cancel_request",
      "Stop future steps; cannot revoke remote work or a signed authorization.",
    ],
  ].map(([name, description]) => ({
    name: name!,
    description: description!,
    inputSchema: {
      type: "object",
      properties: {
        ...strings(["requestId"]),
        ...(name === "x402_get_request"
          ? { waitMs: { type: "integer", minimum: 0, maximum: 5000 } }
          : {}),
        ...(name === "x402_reconcile"
          ? { transactionHash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$", description: "Optional transaction lookup hint; chain evidence is independently verified." } }
          : {}),
      },
      required: ["requestId"],
      additionalProperties: false,
    },
  })),
  {
    name: "x402_lookup_operation",
    description:
      "Look up the original operation. A missing result never authorizes a new purchase.",
    inputSchema: {
      type: "object",
      properties: strings(["operationId"]),
      required: ["operationId"],
      additionalProperties: false,
    },
  },
  {
    name: "x402_export_response",
    description:
      "Export a complete opaque response to a host-approved destination. Does not execute or interpret its content.",
    inputSchema: {
      type: "object",
      properties: strings(["requestId", "destinationRef"]),
      required: ["requestId", "destinationRef"],
      additionalProperties: false,
    },
  },
] as const;

export function isWalletQueryTool(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name !== "x402_request" &&
    walletMcpTools.some((tool) => tool.name === name)
  );
}
