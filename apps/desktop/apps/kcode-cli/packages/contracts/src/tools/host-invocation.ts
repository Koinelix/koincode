declare const hostInvocationBrand: unique symbol;
export type HostToolInvocation = { readonly [hostInvocationBrand]: true };
export interface HostToolInvocationFacts {
  traceId: string;
  spanId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  runtimeScope: "main" | "subagent";
}
export interface HostToolInvocationContext {
  readonly facts: Readonly<HostToolInvocationFacts>;
  readonly signal: AbortSignal;
}
const active = new WeakMap<HostToolInvocation, HostToolInvocationContext>();
const MAX_ID_LENGTH = 256;

/** Runtime wiring only. This proves a live handler call, never payment or task authority. */
export function beginHostToolInvocation(
  facts: HostToolInvocationFacts,
  signal: AbortSignal,
): { token: HostToolInvocation; close(): void } | undefined {
  if (
    signal.aborted ||
    ![
      facts.traceId,
      facts.spanId,
      facts.sessionId,
      facts.turnId,
      facts.toolCallId,
      facts.toolName,
    ].every(
      (value) => typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH,
    ) ||
    (facts.runtimeScope !== "main" && facts.runtimeScope !== "subagent")
  )
    return undefined;
  const token = Object.freeze({}) as HostToolInvocation;
  const ended = new AbortController();
  const lifetimeSignal = AbortSignal.any([signal, ended.signal]);
  // Select fields explicitly so caller-owned objects or extra data cannot enter the witness.
  active.set(
    token,
    Object.freeze({
      signal: lifetimeSignal,
      facts: Object.freeze({
        traceId: facts.traceId,
        spanId: facts.spanId,
        sessionId: facts.sessionId,
        turnId: facts.turnId,
        toolCallId: facts.toolCallId,
        toolName: facts.toolName,
        runtimeScope: facts.runtimeScope,
      }),
    }),
  );
  return {
    token,
    close() {
      active.delete(token);
      ended.abort(new Error("The host tool invocation ended."));
    },
  };
}

/** Returns immutable host facts only for an original, live, same-process object. */
export function readHostToolInvocation(
  value: unknown,
): Readonly<HostToolInvocationFacts> | undefined {
  return readHostToolInvocationContext(value)?.facts;
}

/** The signal also aborts when the owner closes the call, including normal completion. */
export function readHostToolInvocationContext(
  value: unknown,
): HostToolInvocationContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const current = active.get(value as HostToolInvocation);
  return current && !current.signal.aborted ? current : undefined;
}
