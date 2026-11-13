import { createHash } from "node:crypto";
import type { X402RequestInput, RequestView } from "../domain/requestModel.js";
import { requireWallet } from "../domain/errors.js";

export interface HostWalletInvocation {
  readonly facts: Readonly<{
    sessionId: string;
    turnId: string;
    toolCallId: string;
    toolName: string;
    runtimeScope: "main" | "subagent";
  }>;
  /** Must abort on both cancellation and owner close, not just caller cancellation. */
  readonly signal: AbortSignal;
}
export interface HostWalletRequestBridgeOptions {
  readonly sessionId: string;
  readonly toolName: string;
  /** Trusted runtime wiring only. Return the same context object while live; never parse model metadata. */
  readonly readInvocation: (witness: unknown) => HostWalletInvocation | undefined;
}
export interface HostWalletRequestBridge {
  request(input: X402RequestInput, witness: unknown): Promise<RequestView>;
}
const MAX_ID_LENGTH = 256;
const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;

/** Same-process host adapter; wallet authorization and anchored operation history remain authoritative. */
export function createHostWalletRequestBridge(
  client: { request(input: X402RequestInput, source: string, signal?: AbortSignal): Promise<RequestView> },
  options: HostWalletRequestBridgeOptions,
): HostWalletRequestBridge {
  const { sessionId, toolName, readInvocation } = options;
  requireWallet(
    validId(sessionId) && validId(toolName) && typeof readInvocation === "function",
    "OPERATION_CONTEXT_REQUIRED",
    "A trusted host request binding is required.",
  );
  return Object.freeze({
    async request(input: X402RequestInput, witness: unknown): Promise<RequestView> {
      const current = readInvocation(witness);
      requireWallet(
        current && !current.signal.aborted,
        "OPERATION_CONTEXT_REQUIRED",
        "A live host invocation is required.",
      );
      const facts = current.facts;
      requireWallet(
        facts.sessionId === sessionId &&
          facts.toolName === toolName &&
          validId(facts.turnId) &&
          validId(facts.toolCallId) &&
          (facts.runtimeScope === "main" || facts.runtimeScope === "subagent"),
        "OPERATION_CONTEXT_REQUIRED",
        "The host invocation does not match this request bridge.",
      );
      const source = createHash("sha256")
        .update(
          JSON.stringify([
            "koincode.host-wallet-request",
            1,
            sessionId,
            facts.turnId,
            facts.toolCallId,
            toolName,
            facts.runtimeScope,
          ]),
        )
        .digest("hex");
      const snapshot = structuredClone(input);
      // Recheck after copying input; never let an ended invocation reach the SDK journal.
      requireWallet(
        !current.signal.aborted && readInvocation(witness) === current,
        "OPERATION_CONTEXT_REQUIRED",
        "The host invocation ended before submission.",
      );
      return client.request(snapshot, source, current.signal);
    },
  });
}
