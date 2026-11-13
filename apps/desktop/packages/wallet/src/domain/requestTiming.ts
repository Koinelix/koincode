import type { FrozenRequest } from "./requestModel.js";
import { requireWallet } from "./errors.js";

export const HTTP_STAGE_TIMEOUT_MS = 20 * 60 * 1000;
export const REQUEST_ACTION_TIMEOUT_MS = 50 * 60 * 1000;
export const REQUEST_PREPARATION_TIMEOUT_MS = 120000;
export const RESPONSE_PROCESS_TIMEOUT_MS = 120000;

export function httpStageTimeout(request: FrozenRequest): number {
  const value = request.httpTimeoutMs === undefined ? 120000 : request.httpTimeoutMs;
  requireWallet(Number.isSafeInteger(value) && value > 0 && value <= HTTP_STAGE_TIMEOUT_MS,
    "REQUEST_CONTEXT_UNAVAILABLE", "The frozen HTTP deadline is invalid.");
  return value;
}
