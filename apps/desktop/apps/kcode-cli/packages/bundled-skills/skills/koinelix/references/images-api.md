# Image API compatibility

The [OpenAPI snapshot](openapi.yaml) holds the two image operations of the production service's public contract (`https://api.koinelix.com/openapi.json`), refreshed on 2026-11-14. JSON is valid YAML. No credential is embedded. A contract snapshot does not prove the running deployment is enabled or that payment is accepted.

New requests use model-v1 and anonymous_x402 by default. `--prompt <text>` sends only `{"prompt":"<text>"}`; the server selects its configured default published model. An explicitly selected `--model <published-id>` is sent unchanged. Empty or malformed explicit model IDs are rejected. Model-v1 excludes legacy size, quality and output options; reference-image fields are documented by the platform but are not exposed by this text-to-image client.

No service API key is needed for the default path. Authorization is completely omitted, including on the same-body payment submission. A real 402 supplies the quote; the wallet validates it and requires user approval and limits before signing. The merchant body, URL and business key stay identical for the initial request and its single payment submission. A quote never grants payment authority.

Explicit `--access-mode credentialed` remains available to callers deliberately using platform credentials. `--api-version legacy-v1 --access-mode credentialed` preserves the older body format for compatible deployments. Existing saved requests lacking mode fields remain credentialed/legacy-v1. `--recover` keeps the original endpoint, body and access mode and does not issue merchant HTTP or sign again. Do not apply new defaults to unknown old requests. Neither a missing credential nor 401/403 triggers a mode change, new operation or payment retry.

The current platform describes an anonymous payment as one generation attempt, settled before generation and not refunded on generation failure. API Key access can have different entitlements and attempt limits. Those are platform rules, not wallet logic. Do not infer free usage or reuse rights from this client.

The response is synchronous Base64 JSON. Python checks bounded JSON, strict Base64, image signatures and basic dimensions; it does not fully decode image pixels or perform a malware scan. It saves the response before publishing a file. No Go/native decoder is required. Keep raw responses, credentials and payment material out of model context. Failed delivery only permits local recovery, never a replacement purchase.
