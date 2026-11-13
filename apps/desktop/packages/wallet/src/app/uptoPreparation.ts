import { randomBytes } from "node:crypto";
import type { PaymentIntent, PaymentScope } from "../domain/model.js";
import type { UptoAuthorization } from "../domain/uptoAuthorization.js";
import { isPinnedModelRoute, uptoAvailability, type ModelDirectPayment } from "../domain/uptoScheduling.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import type { UptoChainSnapshot } from "./ports.js";
import type { WalletState } from "./state.js";

export function modelDirectPayment(state: WalletState, scope: PaymentScope, walletId: string, facilitator: string): ModelDirectPayment | undefined {
  if (!isPinnedModelRoute(scope)) return;
  const modelIntentIds = new Set<string>();
  for (const record of state.transport?.requests ?? []) {
    if (record.modelPayment && record.paymentIntentId) modelIntentIds.add(record.paymentIntentId);
  }
  return { scope, walletId, facilitator: facilitator.toLowerCase(), modelIntentIds };
}

export const uptoValidAfter = (latest: number) => Math.max(0, latest - 30);
export interface UptoTerms { facilitator: string; timeout: number; sponsoring: boolean }

export class AllowanceWait extends WalletError {
  constructor(message: string, readonly spare: bigint) { super("PAYMENT_QUEUE_REQUIRED", message); }
}

/** Construct only from the signer's own anchored snapshot, never a client observation. */
export function uptoAtSnapshot(scope: PaymentScope, payer: string, intents: readonly PaymentIntent[],
  snapshot: UptoChainSnapshot, terms: UptoTerms, heldAtomic = 0n, directOnly = false, nonces?: Permit2NonceAllocator, direct?: ModelDirectPayment): UptoAuthorization {
  requireWallet(Number.isSafeInteger(terms.timeout) && terms.timeout >= 180 && terms.timeout <= 900 &&
    /^0x[0-9a-f]{40}$/i.test(terms.facilitator), "X402_INVALID_CHALLENGE", "The upto quote has invalid terms.");
  const validAfter = uptoValidAfter(snapshot.latest.timestamp);
  const available = uptoAvailability(intents, { ...snapshot, finalizedTimestamp: snapshot.finalized.timestamp }, direct, validAfter);
  // `heldAtomic` belongs to payments admitted beside this one whose reservations are not in the ledger yet.
  const amount = BigInt(scope.amountAtomic), needPermit = available.availableAtomic - heldAtomic < amount;
  // A payment that fits once its neighbours settle waits for them instead of replacing the allowance under them.
  const spare = available.permitPending ? 0n : available.availableAtomic - heldAtomic;
  if (needPermit && (directOnly || available.availableAtomic >= amount))
    throw new AllowanceWait("The existing allowance is held by payments admitted beside this one.", spare);
  requireWallet(!needPermit || terms.sponsoring, "GAS_SPONSORSHIP_UNAVAILABLE", "The quote does not offer required permit sponsorship.");
  if (available.permitPending || (needPermit && (available.inFlightAtomic !== 0n || heldAtomic !== 0n)))
    throw new AllowanceWait("This payment must wait for the previous allowance authorization.", spare);
  return { network: scope.network, asset: scope.asset, payer, payTo: scope.payTo,
    amountAtomic: scope.amountAtomic, nonce: nonces?.next(scope.subjectId, snapshot.latest.hash, snapshot.nonceBitmaps) ?? ("0x" + randomBytes(32).toString("hex")),
    validAfter, validBefore: snapshot.latest.timestamp + terms.timeout + 120,
    upto: { facilitator: terms.facilitator.toLowerCase(), permitNonce: needPermit ? snapshot.permitNonce : null } };
}

/** One on-chain bitmap read covers up to 256 independent Permit2 signatures. */
export class Permit2NonceAllocator {
  private batch?: { subject: string; word: string; blockHash: string; burned: bigint; nextBit: number };
  next(subject: string, blockHash: string, bitmaps?: ReadonlyMap<string, bigint>): string {
    for (;;) {
      const batch = this.batch;
      if (batch && batch.subject === subject) {
        const observed = bitmaps?.get(BigInt("0x" + batch.word).toString());
        if (observed !== undefined || batch.blockHash === blockHash) {
          batch.burned |= observed ?? 0n;
          batch.blockHash = blockHash;
          while (batch.nextBit < 256) {
            const bit = batch.nextBit++;
            if ((batch.burned & (1n << BigInt(bit))) === 0n)
              return "0x" + batch.word + bit.toString(16).padStart(2, "0");
          }
        }
      }
      this.batch = { subject, word: randomBytes(31).toString("hex"), blockHash, burned: 0n, nextBit: 0 };
    }
  }
}
