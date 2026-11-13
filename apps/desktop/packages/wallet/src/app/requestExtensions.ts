import { requireWallet } from "../domain/errors.js";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Bazaar is inert discovery metadata. Never execute its schema or use it as payment authority. */
export function assertDiscoveryExtensions(value: unknown): void {
  if (value === undefined) return;
  requireWallet(record(value) && Object.keys(value).every(key => key === "bazaar" || key === "eip2612GasSponsoring"),
    "UNSUPPORTED_EXTENSION", "The payment challenge contains an unsupported extension.");
  if (Object.hasOwn(value, "eip2612GasSponsoring")) {
    requireWallet(record(value.eip2612GasSponsoring), "UNSUPPORTED_EXTENSION", "The permit sponsorship declaration is invalid.");
  }
  if (!Object.hasOwn(value, "bazaar")) return;
  const declaration = value.bazaar;
  requireWallet(record(declaration) && record(declaration.info) && record(declaration.schema),
    "UNSUPPORTED_EXTENSION", "The Bazaar discovery declaration is invalid.");
}
