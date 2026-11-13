import type { BlobStore, ResponseReservation } from "./requestPorts.js";
import { requireWallet } from "../domain/errors.js";
import { MAX_CONCURRENT_HTTP_STAGES, RESPONSE_LIMIT } from "../domain/requestValidation.js";

export const RESPONSE_STORAGE_LIMIT = 1536 * 1024 * 1024;
export const RESPONSE_BLOB_ENTRY_LIMIT = 100000;
export const BLOB_ENVELOPE_BYTES = 28;
export const BLOB_ENTRY_BYTES = 4096;
export const RESPONSE_RESERVATION_ENTRIES = 6;
const METADATA_ENTRY_CHARGE = 1024 * 1024 + BLOB_ENVELOPE_BYTES + BLOB_ENTRY_BYTES;
export const RESPONSE_RESERVATION_BYTES =
  2 * (RESPONSE_LIMIT + BLOB_ENVELOPE_BYTES + BLOB_ENTRY_BYTES) +
  4 * METADATA_ENTRY_CHARGE;

export function storedBlobCharge(fileBytes: number): number {
  requireWallet(
    Number.isSafeInteger(fileBytes) &&
      fileBytes >= 0 &&
      Number.isSafeInteger(fileBytes + BLOB_ENTRY_BYTES),
    "RESPONSE_STORAGE_UNAVAILABLE",
    "The protected storage inventory is invalid.",
  );
  return fileBytes + BLOB_ENTRY_BYTES;
}

/** Synchronous accounting owned by one lease-holding blob adapter. No filesystem or timers. */
export class ResponseBudget {
  #used: number;
  #reserved = 0;
  #responses = 0;
  #entries: number;
  #reservedEntries = 0;
  #inventoryComplete: boolean;
  constructor(
    used: number,
    private readonly limit = RESPONSE_STORAGE_LIMIT,
    entries = 0,
  ) {
    requireWallet(
      Number.isSafeInteger(used) &&
        used >= 0 &&
        Number.isSafeInteger(limit) &&
        limit >= 0 &&
        Number.isSafeInteger(entries) &&
        entries >= 0,
      "RESPONSE_STORAGE_UNAVAILABLE",
      "The protected storage budget is invalid.",
    );
    this.#used = used;
    this.#entries = entries;
    this.#inventoryComplete = entries <= RESPONSE_BLOB_ENTRY_LIMIT;
  }
  reclaim(bytes: number): void {
    requireWallet(Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= this.#used && this.#entries > 0,
      "RESPONSE_STORAGE_UNAVAILABLE", "The removed blob charge is invalid.");
    this.#used -= bytes;
    this.#entries--;
  }
  reserve(bytes: number, response = false) {
    return this.allocate(bytes, response ? RESPONSE_RESERVATION_ENTRIES : 1, response);
  }
  reservePaymentMaterial() {
    // Quote reselection and the signed payment header are the only possible writes.
    return this.allocate(2 * METADATA_ENTRY_CHARGE, 2, false, METADATA_ENTRY_CHARGE);
  }
  private allocate(bytes: number, entryCount: number, response: boolean, maxEntryCharge = bytes) {
    requireWallet(
      Number.isSafeInteger(bytes) && bytes >= 0,
      "RESPONSE_STORAGE_UNAVAILABLE",
      "The protected storage reservation is invalid.",
    );
    requireWallet(
      !response || this.#responses < MAX_CONCURRENT_HTTP_STAGES,
      "RESPONSE_CAPACITY_BUSY",
      "All wallet HTTP response slots are in use.",
    );
    requireWallet(
      this.#inventoryComplete && bytes <= this.limit - this.#used - this.#reserved &&
        entryCount <= RESPONSE_BLOB_ENTRY_LIMIT - this.#entries - this.#reservedEntries,
      "RESPONSE_STORAGE_FULL",
      "Protected response capacity is unavailable; existing results are retained.",
    );
    this.#reserved += bytes;
    this.#reservedEntries += entryCount;
    if (response) this.#responses++;
    let remainingEntries = entryCount;
    let remaining = bytes,
      released = false;
    return {
      spend: (cost: number) => {
        requireWallet(
          !released &&
            remainingEntries > 0 &&
            Number.isSafeInteger(cost) &&
            cost >= 0 &&
            cost <= remaining && cost <= maxEntryCharge,
          "RESPONSE_RESERVATION_INVALID",
          "The protected response reservation is unavailable.",
        );
        // Charge before IO; a failed write keeps its full charge until the next inventory.
        remainingEntries--;
        this.#reservedEntries--;
        this.#entries++;
        remaining -= cost;
        this.#reserved -= cost;
        this.#used += cost;
      },
      release: () => {
        if (released) return;
        released = true;
        this.#reservedEntries -= remainingEntries;
        remainingEntries = 0;
        this.#reserved -= remaining;
        remaining = 0;
        if (response) this.#responses--;
      },
    };
  }
}

export function acquireResponseCapacity(blobs: BlobStore, purpose?: "payment-material"): ResponseReservation {
  const reservation = blobs.reserveResponse(purpose);
  if (
    !reservation ||
    typeof reservation.put !== "function" ||
    typeof reservation.release !== "function"
  ) {
    void Promise.resolve(reservation).catch(() => {});
    requireWallet(
      false,
      "INVALID_REQUEST_CONFIGURATION",
      "A synchronous response reservation is required.",
    );
  }
  return reservation;
}
