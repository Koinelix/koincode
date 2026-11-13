/** Fixed diagnostic stages contain no payment material or provider error text. */
export async function paymentStage<T>(id: string, stage: "admission" | "admission_chain" | "prepare" |
  "authorization" | "approval_wait" | "approval_decision" | "final_chain" | "history_proof" |
  "native_sign" | "native_permit" | "protected_storage" | "reserve_commit" | "signed_commit" | "request_commit" | "sign", action: () => Promise<T>): Promise<T> {
  const started = performance.now(), startedAt = new Date().toISOString();
  let outcome = "failed";
  try { const result = await action(); outcome = "succeeded"; return result; }
  finally {
    console.info("[wallet-stage]", JSON.stringify({
      id: /^[0-9a-f-]{36}$/i.test(id) ? id : "internal", stage, startedAt,
      durationMs: Math.round(performance.now() - started), outcome,
    }));
  }
}

export function paymentQueueTiming(id: string, stage: "allowance_wait" | "authorization_queue", durationMs: number) {
  if (durationMs > 0) console.info("[wallet-stage]", JSON.stringify({
    id: /^[0-9a-f-]{36}$/i.test(id) ? id : "internal", stage, durationMs: Math.round(durationMs),
  }));
}
