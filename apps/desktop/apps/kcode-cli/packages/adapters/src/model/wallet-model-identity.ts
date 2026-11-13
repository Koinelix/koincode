export interface WalletModelIdentity {
  sessionId?: string;
  turnId?: string;
  spanId?: string;
  attributes?: Record<string, string | number | boolean>;
}

/**
 * A wallet-paid model request belongs to the bound session, or to a first-level subagent whose
 * runtime-built trace names the bound session as its parent. Payments always stay bound to that session.
 */
export function walletModelIdentityAllowed<T extends WalletModelIdentity>(boundSessionId: string, identity: T | undefined,
  actorKind: string | undefined): identity is T & { sessionId: string; turnId: string; spanId: string } {
  if (!identity?.turnId || !identity.spanId || !identity.sessionId) return false;
  if (identity.sessionId === boundSessionId) return true;
  // Auxiliary calls inside a subagent (compaction, WebFetch, WebSearch) carry no actor kind; any
  // other declared actor kind, such as a workflow child, is not a first-level subagent.
  return (actorKind === undefined || actorKind === "subagent") &&
    identity.sessionId.startsWith("sess_subagent_") &&
    identity.attributes?.parentSessionId === boundSessionId;
}
