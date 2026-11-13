import { types } from "node:util";
import { verifyTypedData } from "ethers";
import type { KeyCustody, ManagedKey, PaymentSigningContext } from "../app/ports.js";
import type { ExactAuthorization } from "../domain/model.js";
import { localPaymentSigner } from "./localPaymentSigner.js";
import { requireWallet } from "../domain/errors.js";
import { unsignedSigningFailure } from "../app/signingProof.js";
import { createGeneralExactPayment, generalExactPaymentDigest, generalExactPaymentTypedData, type GeneralExactPayment } from "./generalExactPayment.js";

/** Private actual-native factory result only. Its shape is not provenance or
 * authority. The fixed payment wrapper supplies the real kernel-peer session;
 * no Main/model constructor or exported SDK factory accepts these callbacks. */
export interface GeneralExactPaymentSession {
  readonly digest: string;
  assertCurrent(): void;
  /** Synchronous native admission, then bounded actual IO. Never decrypt anew,
   * retry, or accept a different digest after the owner's final check. */
  commit(digest: string): Promise<string>;
  close(): Promise<void>;
}
type Open = (intent: GeneralExactPayment, signal?: AbortSignal) => Promise<GeneralExactPaymentSession>;
/** Uses the existing custody for legacy keys and protected signature storage.
 * General keys have no legacy keyRef or keystore and cannot be exported here. */
export class GeneralPaymentCustody implements KeyCustody {
  constructor(private readonly legacy: KeyCustody, private readonly open: Open,
    private readonly signLocalAllowance?: NonNullable<KeyCustody["signAllowance"]>) {}
  readonly acquireSigningSlot = localPaymentSigner();
  async signAllowance(...args: Parameters<NonNullable<KeyCustody["signAllowance"]>>) {
    if (args[0].kind === "general_source") {
      requireWallet(this.signLocalAllowance, "GENERAL_ACCOUNT_UNAVAILABLE", "Local approval signing is unavailable.");
      return this.signLocalAllowance(...args);
    }
    requireWallet(this.legacy.signAllowance, "GENERAL_ACCOUNT_UNAVAILABLE", "Legacy approval signing is unavailable.");
    return this.legacy.signAllowance(...args);
  }
  create(...args: Parameters<KeyCustody["create"]>) { return this.legacy.create(...args); }
  importTestWallet(...args: Parameters<KeyCustody["importTestWallet"]>) { return this.legacy.importTestWallet(...args); }
  restoreBackup(...args: Parameters<KeyCustody["restoreBackup"]>) { return this.legacy.restoreBackup(...args); }
  protectSignature(...args: Parameters<KeyCustody["protectSignature"]>) { return this.legacy.protectSignature(...args); }
  exportBackup(...args: Parameters<KeyCustody["exportBackup"]>) {
    requireWallet(args[0].kind !== "general_source", "GENERAL_PAYMENT_OWNER_REQUIRED", "Export this source in the protected wallet window.");
    return this.legacy.exportBackup(...args);
  }
  revealPrivateKey(key: ManagedKey, signal?: AbortSignal): Promise<string> {
    requireWallet(key.kind !== "general_source" && this.legacy.revealPrivateKey, "GENERAL_ACCOUNT_UNAVAILABLE", "Use the original source management window.");
    return this.legacy.revealPrivateKey(key, signal);
  }
  async signAuthorization(key: ManagedKey, authorization: ExactAuthorization, finalCheck: (value: Readonly<ExactAuthorization>) => void,
    signal?: AbortSignal, context?: Readonly<PaymentSigningContext>): Promise<string> {
    return this.signPayment(key, authorization, finalCheck, signal, context, false);
  }
  async signPermitAuthorization(key: ManagedKey, authorization: import("../domain/uptoAuthorization.js").UptoAuthorization,
    finalCheck: (value: Readonly<ExactAuthorization>) => void, signal?: AbortSignal, context?: Readonly<PaymentSigningContext>): Promise<string> {
    return this.signPayment(key, authorization, finalCheck, signal, context, true);
  }
  private async signPayment(key: ManagedKey, authorization: ExactAuthorization, finalCheck: (value: Readonly<ExactAuthorization>) => void,
    signal: AbortSignal | undefined, context: Readonly<PaymentSigningContext> | undefined, permit: boolean): Promise<string> {
    if (key.kind !== "general_source") {
      if (!permit) return this.legacy.signAuthorization(key, authorization, finalCheck, signal, context);
      requireWallet(this.legacy.signPermitAuthorization && authorization.upto, "PERMIT_MISMATCH", "The custody cannot sign this fixed permit.");
      return this.legacy.signPermitAuthorization(key, authorization as import("../domain/uptoAuthorization.js").UptoAuthorization, finalCheck, signal, context);
    }
    let session: GeneralExactPaymentSession | undefined, commitAttempted = false;
    try {
      requireWallet(context && !signal?.aborted && !types.isAsyncFunction(finalCheck), "INVALID_FINAL_CHECK", "A current synchronous signing check and original intent are required.");
      const intent = createGeneralExactPayment(key, authorization, context, permit), expected = generalExactPaymentDigest(intent);
      session = await this.open(intent, signal);
      requireWallet(session && session.digest === expected && typeof session.commit === "function" && typeof session.close === "function",
        "PERMIT_MISMATCH", "The prepared signing session does not match the original intent.");
      const current: unknown = session.assertCurrent();
      if (current instanceof Promise) void current.catch(() => {});
      requireWallet(current === undefined && !signal?.aborted, "WALLET_OPERATION_ABORTED", "The signing session is no longer current.");
      const result: unknown = finalCheck(intent.authorization);
      if (result instanceof Promise) void result.catch(() => {});
      requireWallet(result === undefined, "INVALID_FINAL_CHECK", "The final signing check must complete synchronously.");
      requireWallet(!signal?.aborted, "WALLET_OPERATION_ABORTED", "Signing was canceled during the final check.");
      commitAttempted = true;
      const signature = await session.commit(expected);
      requireWallet(!signal?.aborted && /^0x[0-9a-f]{130}$/i.test(signature), "WALLET_OPERATION_ABORTED", "The signing result is unavailable.");
      const data = generalExactPaymentTypedData(intent);
      requireWallet(verifyTypedData(data.domain, data.types, data.message, signature).toLowerCase() === intent.authorization.payer,
        "PERMIT_MISMATCH", "The signature does not match the frozen payment authorization.");
      return signature;
    } catch (error) {
      if (!commitAttempted) throw unsignedSigningFailure(error);
      throw error;
    } finally { await session?.close(); }
  }
}
