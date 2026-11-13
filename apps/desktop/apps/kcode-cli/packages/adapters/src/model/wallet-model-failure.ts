const SAFE_CODES = new Set([
  "RPC_UNAVAILABLE", "RPC_TIMEOUT", "RPC_RATE_LIMITED", "RPC_HTTP_UNAVAILABLE", "RPC_NODE_UNAVAILABLE", "RPC_REJECTED",
  "RPC_RESPONSE_INVALID", "RPC_RESPONSE_TOO_LARGE", "RPC_BUDGET_EXHAUSTED", "RPC_BUSY",
  "RPC_CHAIN_MISMATCH", "RPC_ASSET_MISMATCH", "RPC_EVIDENCE_INVALID", "QUOTE_EXPIRED",
  "WALLET_LOCKED", "WALLET_BUSY", "WALLET_OPERATION_ABORTED", "WALLET_REQUEST_CANCELED",
  "WALLET_PAYMENT_UNKNOWN", "PAYMENT_ADMISSION_EXPIRED", "PAYMENT_APPROVAL_REQUIRED",
  "PAYMENT_APPROVAL_UNAVAILABLE", "PAYMENT_CONTEXT_CHANGED", "PAYMENT_QUEUE_TIMEOUT",
  "PAYMENT_WAIVER_BROKEN", "PAYMENT_QUEUE_FULL", "PAYMENT_QUEUE_REQUIRED", "PAYMENT_NETWORK_MISMATCH",
]);

const BUSY_CODES = new Set(["capacity_exhausted", "rate_limited"]);
const CONNECTION_CODES = new Set([
  "WALLET_PROCESS_EXITED", "WALLET_NOT_OPEN", "WALLET_CHANNEL_CLOSED", "WALLET_CHANNEL_UNAVAILABLE",
  "WALLET_MODEL_CHANNEL_UNAVAILABLE", "WALLET_CLIENT_NOT_CONFIGURED", "WALLET_UNAVAILABLE",
  "WALLET_TIMEOUT", "WALLET_REQUEST_TIMEOUT", "WALLET_LOCK_UNCERTAIN", "WALLET_DRAIN_UNCERTAIN",
]);
const ACCOUNT_MESSAGE = "The selected account is unavailable to this wallet connection. " +
  "Open the wallet to reconnect or select an available payment account. Check the original payment record before retrying.";
const CONNECTION_MESSAGE = "The wallet service disconnected before this request completed. " +
  "Open the existing wallet to reconnect, then check the original payment record before retrying.";
const BUSY_MESSAGE = "The model service was busy and did not start this request. Retry later. " +
  "Any payment authorization for it stays reserved until the wallet confirms it was not used.";

const EXPOSURE_MESSAGE = "This wallet has outstanding payment authorizations that exceed the service's available allowance or balance. " +
  "Wait for the wallet to reconcile them and check the original payment record before retrying. " +
  "A rejected request's authorization may remain reserved until its expiry is confirmed on chain.";

function platformCodeMessage(status: unknown, code: unknown): string | undefined {
  if (status === 503 && code === "payment_unavailable")
    return "Payment verification is temporarily unavailable. If you already signed, the wallet tracks the original authorization. " +
      "Check its amount and status in the wallet payment history before starting another request.";
  if (status === 409 && code === "payer_exposure_exceeded") return EXPOSURE_MESSAGE;
  return status === 429 && typeof code === "string" && BUSY_CODES.has(code) ? BUSY_MESSAGE : undefined;
}

/** Reads only known status/code pairs; oversized or malformed bodies yield nothing. */
function platformMessage(statusCode: unknown, responseBody: unknown): string | undefined {
  if ((statusCode !== 429 && statusCode !== 409 && statusCode !== 503) || typeof responseBody !== "string" || responseBody.length > 8192) return undefined;
  try {
    const code = (JSON.parse(responseBody) as { error?: { code?: unknown } } | null)?.error?.code;
    return platformCodeMessage(statusCode, code);
  } catch {
    return undefined;
  }
}

/** Read a bounded cause chain; only fixed diagnostics may reach the user. */
export function walletModelFailureMessage(error: unknown): string {
  const pending: unknown[] = [error], seen = new Set<unknown>();
  for (let count = 0; pending.length && count < 12; count++) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const value = current as { providerCode?: unknown; providerMessage?: unknown; message?: unknown; code?: unknown; cause?: unknown; lastError?: unknown;
      responseStatus?: unknown; statusCode?: unknown; responseBody?: unknown };
    const message = platformMessage(value.statusCode, value.responseBody) ??
      platformCodeMessage(value.responseStatus ?? value.statusCode, value.providerCode);
    if (message) return message;
    if (value.providerCode === "validation_failed" && value.providerMessage === "Output limit exceeds model capacity")
      return "The model output limit exceeds the service capacity. Review the output limit before starting another request.";
    if ([value.code, value.message].some(code => code === "WALLET_NOT_FOUND")) return ACCOUNT_MESSAGE;
    // Channel failures describe service availability, not the merchant's payment outcome.
    if ([value.code, value.message].some(code => typeof code === "string" && CONNECTION_CODES.has(code)))
      return CONNECTION_MESSAGE;
    if (typeof value.message === "string" && SAFE_CODES.has(value.message))
      return `Wallet model request failed: ${value.message}. Check the original payment record before retrying.`;
    pending.push(value.cause, value.lastError);
  }
  return "The wallet model request ended without a complete result. Check the original payment before retrying.";
}
