import { randomUUID } from "node:crypto";
import { requireWallet } from "../domain/errors.js";
import { audit, type RuntimeContext } from "./runtimeContext.js";
export async function releaseUnsigned(ctx: RuntimeContext, intentId: string): Promise<void> {
  await ctx.state.mutate((state) => {
    const intent = state.intents.find((intent) => intent.intentId === intentId)!;
    requireWallet(
      intent.status === "SIGNING" && intent.reserved && !intent.spent,
      "STATE_CONFLICT",
      "Unsigned failure conflicts with recorded payment evidence.",
    );
    intent.status = "FAILED_UNSIGNED";
    intent.reserved = false;
    const permit = state.permits.find((permit) => permit.intentId === intentId)!;
    permit.status = "invalidated";
    state.events.push({
      eventId: randomUUID(),
      subjectId: intent.subjectId,
      intentId,
      kind: "RELEASE",
      reservedDelta: (-BigInt(intent.amountAtomic)).toString(),
      spentDelta: "0",
      settledAt: null,
      recordedAt: state.trustedTime,
      evidenceKey: null,
    });
    audit(state, "PAYMENT_FAILED_UNSIGNED", intent.subjectId, { intentId });
  });
}
