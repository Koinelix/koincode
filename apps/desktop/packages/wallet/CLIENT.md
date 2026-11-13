# Generic x402 payment client

The wallet owns payment authorization, signing, budgets and chain reconciliation. A caller owns its merchant HTTP, API credentials, request persistence and results. A caller can be a Skill, an MCP server, a script or another application. No merchant configuration is required to connect to the wallet.

## Authenticated local protocol

Use an existing registered external client and the private socket published by the wallet service. The current Unix adapter uses `wallet-mcp.sock` in its service directory. Never derive or change the active wallet profile. Windows requires the ACL-authenticated pipe adapter; the Unix socket is not a Windows fallback.

Send the client authentication frame alone, then wait for the authentication reply before sending protocol frames:

```json
{"clientId":"<registered-client-id>","token":"<protected-client-token>","protocol":"payment-v1"}
```

The successful reply is `{"authenticated":true}`. Keep tokens in the calling application's protected store or a private inherited pipe, never in prompts, CLI arguments, ordinary environment variables or logs. Client registration, revocation and wallet unlock use the wallet's trusted control plane; the payment protocol exposes none of them.

Protocol requests are newline-delimited UTF-8 JSON, version 1, with strictly increasing integer IDs starting at 1:

```json
{"version":1,"id":1,"method":"capabilities","params":{}}
```

Replies are `{"version":1,"id":1,"ok":true,"value":{...}}` or `{"version":1,"id":1,"ok":false,"code":"ERROR_CODE"}`. Frames are limited to 128 KiB, eight pending calls and 128 calls per connection. A connection is bounded to 50 minutes. Do not reconnect and repeat a possibly signed authorization automatically.

| Method | Parameters | Result |
|---|---|---|
| `capabilities` | `{}` | Protocol version, supported network and method names; no spending grant |
| `prepare_payment` | `{operationId, payment}` | Original `paymentId`, wallet operation, quote amount/network and state |
| `authorize_payment` | `{paymentId, requestDigest}` | `{intentId, paymentHeader}` through this private client connection only |
| `get_payment` | `{paymentId}` | Non-secret original payment facts |
| `reconcile_payment` | `{paymentId, transactionHash?}` | Chain-verified facts; no merchant HTTP or new signature |
| `cancel_payment` | `{paymentId}` | Stops unadmitted future work; cannot retract an existing signature or remote payment |

`operationId` is a stable UUID saved by the caller before its first effect. Reusing it with changed payment input fails. `payment` has exactly these fields:

```typescript
type Payment = {
  url: string;
  method: "GET" | "POST";
  requestDigest: string;       // 64 lowercase hex characters
  bodySha256: string | null;  // 64 lowercase hex characters
  bodyByteLength: number;
  credentialTag: string | null; // Opaque version identity, never an API Key
  paymentRequired: string;    // Actual PAYMENT-REQUIRED header from the merchant
};
```

The wallet independently validates the offered x402 v2 exact challenge, supported network/asset, recipient, amount, freshness, client scope, user grants and budgets. Its current payment implementation supports Base Sepolia test USDC. There is no arbitrary typed-data or transaction signing endpoint. Body digests supplied by a caller do not prove what that caller actually sends to a merchant.

`paymentHeader` is consumable payment material. Keep it inside the caller's trusted HTTP implementation; an MCP server must not place it in its model-facing tool result. Submit the original HTTP request using the original body, credential identity and business idempotency key. The wallet does not issue this merchant request. A signature, HTTP 200 or transaction hash alone does not prove settlement.

`transactionHash` is an optional 0x-prefixed 32-byte transaction lookup hint from the merchant response. It is not settlement evidence. The wallet verifies the original authorization and adjacent token transfer against canonical chain receipts before accounting. Omit it to use bounded nonce-history reconciliation. Invalid or unavailable evidence never releases a reservation. The general `x402_reconcile` MCP query accepts the same optional hint.

## KoinCode host integration

The official host integration provides `wallet_run_client` for an explicitly selected independent Python or Node client. It injects the same payment protocol through private fd 3 and binds the connection to the real invocation. It is an optional host adapter, not a requirement for other applications and not a wallet script executor.

The host additionally provides `context` (session-owned state/output directories and a stable task identity) and optional `credential.read` (a separately configured, exact-target service credential). These are host services and are absent from the wallet protocol. Scripts may instead use their own credential provider. Neither service grants payment authority.

Hosted `authorize_payment` takes `{paymentId}`: the proxy supplies the original digest from this invocation's preparation. Hosted operations are scoped to the current trusted session. The host never exposes a client token or payment material to the model. It accepts only a bounded result receipt, not arbitrary stdout/stderr:

```json
{"status":"completed","operationId":"<business-operation-uuid>","paymentId":"<optional-wallet-payment-uuid>","artifacts":[{"name":"result.png","mediaType":"image/png"}]}
```

Status may be `completed`, `recovered`, `pending` or `failed`; `diagnosticCode` is optional. Artifacts must be ordinary new files in the supplied output directory, up to eight files, 32 MiB per file and 64 MiB total. The host publishes them through ordinary session artifact storage and returns URIs. It does not parse merchant JSON or decode images. State belongs to the caller; financial state belongs to the wallet.

The client subprocess is not an OS sandbox. A malicious client can misuse its own credentials or payment material. Native wallet approval and budget checks remain mandatory. Process exit, cancellation or client revocation invalidates future admission; already produced signatures remain financial facts and may require reconciliation.
