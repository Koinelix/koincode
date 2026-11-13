import { requireWallet } from "./errors.js";

/** An absent empty stream is valid; missing nonempty or unregistered streams are not. */
export function assertGeneralSigningInventory(expected: readonly { id: string; sequence: number }[], actual: readonly string[]): void {
  const listed = new Set(actual), known = new Set(expected.map((stream) => stream.id));
  requireWallet(expected.length <= 3584 && known.size === expected.length && actual.length <= 3584 && listed.size === actual.length &&
    actual.every((id) => known.has(id)) && expected.every((stream) => stream.sequence === 0 || listed.has(stream.id)),
  "SIGNING_CONTINUITY_CONFLICT", "The signing stream inventory is inconsistent.");
}
