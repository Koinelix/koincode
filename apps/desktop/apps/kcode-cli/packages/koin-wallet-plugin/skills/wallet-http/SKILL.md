---
name: wallet-http
description: Connect independent x402 clients to the general wallet, inspect payment state and recover without buying again.
---

# General wallet payment

The wallet supplies payment authorization, limits, signing and chain records. The caller may be a Skill, an MCP server, a script or another application. The caller owns its merchant HTTP, service configuration, API credentials and results. Do not configure a merchant in the wallet. Installing this plugin does not unlock a wallet or authorize spending.

Use `wallet_get_capabilities` or `wallet_get_info` for non-secret wallet status. Missing service credentials do not prevent a wallet connection. The application maintains its built-in connection automatically; external applications authenticate through the wallet's public client protocol. Never inspect wallet files, private keys or Keychain to work around a connection error.

For an independent caller script, the official host offers the generic `wallet_run_client` tool. Select its absolute script path, `python3` or `node` runtime and non-secret arguments. When the user sets a lower per-payment ceiling for this invocation, set the tool's optional `paymentLimit` object with the exact network, token address and `maxAmountAtomic` integer string. The host enforces it before signing; do not require lowering the wallet's global settings. For Base Sepolia USDC, 0.1 USDC is `100000` atomic units. This ceiling can only restrict payments and never replaces wallet approval or limits. The script receives the authenticated payment client through a private pipe. Other applications can use the same payment protocol directly; they do not need this launcher or a business-specific plugin.

Follow the selected business Skill for its script entry, service parameters and recovery. Do not submit merchant bodies to legacy `x402_request`, construct payment headers in model text, supply a client identity/grant, or use arbitrary signing tools. Only a valid actual 402 triggers payment. A request satisfied by existing merchant rights can complete without a wallet.

KoinCode uses the wallet's existing authorization policy. A valid matching grant and an unlocked wallet may pay automatically within both the wallet limits and any lower invocation ceiling. Missing authorization or a locked wallet follows the existing trusted confirmation/unlock flow; the user completes any required system authentication. Do not request another confirmation merely because the call came from a Skill, create broader grants, or change limits. Ordinary parameter saves do not require product-initiated Touch ID.

Never expose API keys, client credentials, payment headers or full Base64 to the model. A script result contains non-secret status and ordinary session artifact URIs. Show images through normal Markdown artifact references; the wallet does not decode or display images. HTTP success and image delivery do not prove chain settlement.

For an uncertain or canceled operation, query/reconcile its original payment and recover its already saved business result. Do not create another purchase or change nonce/identity to bypass uncertainty. A lost preview is not permission to regenerate. If a required connection, credential provider or recovery capability is unavailable, report the actual diagnostic and stop that operation without repeatedly probing or buying again.


For an ordinary service request without an additional user-specified spending ceiling, omit the entire `paymentLimit` property. Existing wallet authorizations and wallet limits remain authoritative. Never invent `maxAmountAtomic: "0"` as a placeholder or assume zero means unlimited: an explicit zero forbids all positive payments. If an explicit ceiling rejects a quote, do not increase it or repeat the operation automatically. A separate explicit user request is required for a new independent operation.
