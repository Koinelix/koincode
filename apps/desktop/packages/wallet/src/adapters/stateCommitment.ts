import type { WalletState, StateCommitment } from "../app/state.js";
import { digest, eventHash } from "./canonical.js";
const GENESIS = "0".repeat(64);
export function stateCommitment(state: WalletState, storageBinding: string): StateCommitment {
  let ledgerHead = GENESIS;
  for (const event of state.events) ledgerHead = eventHash(ledgerHead, event);
  return {
    version: 1,
    installationId: state.installationId,
    ownerId: state.ownerId,
    managementEpoch: state.managementEpoch,
    initializationAttempt: state.initializationAttempt,
    revision: state.revision,
    storageBinding,
    controlDigest: digest({
      epoch: state.managementEpoch,
      defaultWalletId: state.defaultWalletId,
      auditEvents: state.auditEvents,
      policies: state.policies,
      grants: state.grants,
      clients: state.clients,
      sessions: state.sessions,
      ...(state.transport ? { transport: state.transport } : {}),
    }),
    historyDigest: digest({
      wallets: state.wallets,
      subjects: state.subjects,
      intents: state.intents,
      permits: state.permits,
      ledgerHead,
      trustedTime: state.trustedTime,
      observations: state.observations,
      recoveries: state.recoveries,
    }),
    ledgerHead,
  };
}
