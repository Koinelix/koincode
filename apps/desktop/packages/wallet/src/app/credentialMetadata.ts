import type { WalletState } from "./state.js";

export interface CredentialReferenceView {
  ref: string;
  origin: string;
  path: string;
  headerName: "authorization" | "x-api-key";
}

/** Non-secret projections never include storage accounts, values or another client's authority. */
export function credentialReferences(state: WalletState, clientId: string): CredentialReferenceView[] {
  if (!state.clients.some((client) => client.clientId === clientId && client.active && client.ownerId === state.ownerId) ||
      state.transport?.epoch !== state.managementEpoch) return [];
  return state.transport.credentials.filter((record) => record.active && record.epoch === state.managementEpoch &&
    record.ownerId === state.ownerId && record.clientIds.includes(clientId))
    .map(({ ref, origin, path, headerName }) => ({ ref, origin, path, headerName }));
}
