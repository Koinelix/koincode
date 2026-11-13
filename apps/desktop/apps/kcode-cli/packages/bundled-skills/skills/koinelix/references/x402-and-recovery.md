# x402, attempts and recovery

## Version and access scope

The detailed entitlement and recovery table below describes the historical credentialed contract. Apply it only if the selected service version still declares those semantics. The current anonymous contract offers one paid attempt and no refund on generation failure; it does not inherit the credentialed three-attempt entitlement. The current client never automatically invokes merchant recovery or retries a paid request. See [the current API snapshot and modes](images-api.md).

## Before sending

The platform authenticates the user and validates the request, then checks the original request, pending work and existing opportunities, then quota, before offering x402. Existing rights can satisfy a request without a wallet or new payment. An original business request must retain its URL, exact body, credential identity and idempotency key through submission, payment resend and recovery. A platform purchase ID is only a reference and is not an access credential.

A purchase permits at most three total attempts including the first, within 24 hours, and ends on success. A known failed attempt can be followed by a user-authorized new logical attempt using a new business key; a technical resend of the old key only observes the old request. Do not create extra attempts or purchases beyond the user's task. A next attempt may use an existing opportunity, quota, or a new payment; it is not guaranteed free. An unknown outcome is not a known failure.

## Recover an original request

For an uncertain or lost result, preserve the request and operation IDs and report the original status. A platform recovery protocol requires the original persisted request context and enforced no-new-payment mode. The current independent Python script only recovers locally retained responses; it does not automatically invoke the merchant recovery protocol; do not claim it has, invent a new key, issue a recovery request yourself, or replay a possibly paid operation. A 404 is not proof of nonpayment or permission for another signature.

The wallet independently reconciles any signed authorization against the chain. A signature may have been ignored when the platform found existing rights, so even a 200, `X-Koinelix-Funding-Rail: x402`, or `PAYMENT-RESPONSE` is not proof of this request's settlement. Keep pending exposure until the wallet establishes the chain outcome; report business and payment facts separately.

## Response handling

The table describes platform outcomes and future recovery requirements. The current Python entry only re-delivers a retained local response. After an uncertain or failed result, do not independently resend, replace, invoke merchant recovery or sign again.

| Response | Action |
| --- | --- |
| 200 with valid image | Save it and display it; independently report payment state. |
| Initial 402 with valid `PAYMENT-REQUIRED` | Let the compatible client evaluate the quote, user grant and budgets. Keep the original request and business key. Invalid or missing payment requirements stop the payment flow. |
| Host reports `PAYMENT_QUOTE_DISPLAY_UNAVAILABLE` | Stop: the host could not confirm display of the quote. Preserve the original IDs and report the payment state only from trusted wallet evidence. Do not automatically create a new request or retry payment. |
| Signed request: 402 `payment_quote_mismatch` or `payment_invalid` with a valid new quote | Do not infer nonpayment. Wait for the wallet to resolve the original signed authorization. Only when it proves expired and unused may the client refresh the same request under its safe-replay policy and, if permitted, sign a fresh quote. If it was used, do not pay again; recover the original request. A missing or invalid quote is a compatibility error and stops the flow. |
| Signed request: 402 `settlement_failed` | The original key is bound to a failed purchase; do not pay again under it. If the wallet proves the original authorization expired and unused, a separately permitted new business request may use a new key and counts toward the user's task. If it was used, do not create a new payment; recover under the original key while the platform reconciles the purchase. Unknown or canceled remains blocked. |
| Signed request: 409 `funding_changed` | The platform selected existing rights or has pending entitlement. The wallet retains exposure until chain resolution. Resend the original key and body without a payment signature, with new payment disabled, to use the existing rights; do not create a new business key. |
| Signed request: 429 `rate_limited` or 503 `payment_unavailable` | The response cannot prove the signature was unused. Retain exposure, do not re-sign, and report the limit or outage. Later recover or retry the original operation under its safe policy. |
| 202, including `failed_unsettled` | Preserve and report the pending purchase or payment state; recover and wait for evidence. `failed_unsettled` alone is not chain proof. |
| 409 `attempt_in_progress` | Wait and recover the original operation. |
| 409 `image_result_unavailable` | Use an already saved local image, or report that the server cannot recover it. Do not silently regenerate. |
| 409 `attempt_not_started` | Do not secretly execute under the old key. A further explicitly requested business attempt uses a new key after the original state is understood. |
| 409 `idempotency_conflict` or `payment_reuse_conflict` | Stop and diagnose; do not change keys or nonce to bypass the conflict. |
| 401 or 403 | Diagnose the platform key, user or scope. Do not request wallet payment. |
| Recovery 404, timeout, cancellation, malformed response, or other unknown | Preserve the original context and unknown payment risk. Do not assume a free retry, new authorization, or completed delivery. |

Do not automatically replace a signed or uncertain request in the current client integration. An independent request explicitly initiated by the user may proceed without resolving the earlier request; it may consume existing rights or quota, or require a new payment. Preserve the earlier operation and do not present this as recovery or a guaranteed free retry. A changed price, recipient or other once-approved field requires fresh approval. A canceled authorization does not automatically trigger another signature.
