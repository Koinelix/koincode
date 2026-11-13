import type { StoredQuote } from "../domain/requestModel.js";
import type { PaymentScope } from "../domain/model.js";
import type { ClientHandle } from "./sessions.js";
export interface PaymentBuilder {
  build(input: {
    handle: ClientHandle;
    walletAddress: string;
    scope: PaymentScope;
    quote: StoredQuote;
    signal: AbortSignal;
    assertCurrent: () => void;
    replacementFrom?: string;
    unsignedRetryFrom?: string;
    uptoShared?: boolean;
    onReserved?: (intentId: string) => void;
  }): Promise<{ intentId: string; header: string }>;
}
