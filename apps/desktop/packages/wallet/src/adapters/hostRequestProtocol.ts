import { WalletError } from "../domain/errors.js";
import type { WalletClientPort } from "./walletClient.js";
import type { HostPaymentInput, HostPaymentMaterial, HostPaymentPrepared } from "../domain/requestModel.js";
export type HostRequestClient = Pick<WalletClientPort, "request"> & {
  callTool?(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  prepareHostPayment?(input: HostPaymentInput, source: string, signal?: AbortSignal): Promise<HostPaymentPrepared>;
  submitHostPayment?(requestId: string, requestDigest: string, signal?: AbortSignal): Promise<HostPaymentMaterial>;
  callPaymentClient?(method: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
};
/** A private ordered, reliable endpoint. The host owns endpoint creation and transfer. */
export interface HostRequestMessagePort {
  send(message: string): void;
  subscribe(message: (value: unknown) => void, closed: () => void): () => void;
  close(): void;
}
export const HOST_REQUEST_CAPACITY = 32;
export function hostRequestHasCapacity(entries: Iterable<{ statusProbe: boolean }>, statusProbe: boolean): boolean {
  let count = 0;
  for (const entry of entries) if (entry.statusProbe === statusProbe) count++;
  return count < (statusProbe ? 1 : HOST_REQUEST_CAPACITY);
}
export const HOST_REQUEST_MESSAGE_BYTES = 2 * 1024 * 1024;
export const hostRequestError = (code = "WALLET_CHANNEL_CLOSED") =>
  new WalletError(
    code,
    "The wallet request channel could not complete this call. No new retry is authorized.",
  );
export const requestCode = (error: unknown): string =>
  error instanceof WalletError && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
    ? error.code
    : "WALLET_REQUEST_FAILED";
export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
export function encodeHostRequest(value: unknown): string {
  const text = JSON.stringify(value);
  if (typeof text !== "string" || Buffer.byteLength(text) > HOST_REQUEST_MESSAGE_BYTES)
    throw hostRequestError("REQUEST_TOO_LARGE");
  return text;
}
export function decodeHostRequest(text: unknown): Record<string, unknown> {
  if (typeof text !== "string" || Buffer.byteLength(text) > HOST_REQUEST_MESSAGE_BYTES)
    throw hostRequestError("WALLET_CHANNEL_PROTOCOL");
  const value: unknown = JSON.parse(text);
  if (
    !record(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.id) ||
    (value.id as number) <= 0
  )
    throw hostRequestError("WALLET_CHANNEL_PROTOCOL");
  return value;
}
