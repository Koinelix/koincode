import { requireWallet } from "../domain/errors.js";
import type { TransportState, RequestRecord } from "../domain/requestModel.js";
import type { ClientContext } from "../domain/model.js";
import type { WalletState } from "./state.js";
export function transport(state: WalletState): TransportState {
  requireWallet(
    state.transport && state.transport.epoch === state.managementEpoch,
    "OPERATION_HISTORY_INCOMPLETE",
    "Operation history continuity must be recovered before accepting or looking up work.",
  );
  return state.transport;
}
export function newTransport(epoch: string): TransportState {
  return {
    version: 1,
    epoch,
    historyComplete: true,
    requests: [],
    credentials: [],
    tokens: [],
    bodies: [],
  };
}

export function operationHistory(state: WalletState, clientId: string): TransportState {
  const t = transport(state);
  requireWallet(
    t.historyComplete ||
      state.clients.some(
        (c) => c.clientId === clientId && c.active && c.registrationEpoch === state.managementEpoch,
      ),
    "OPERATION_HISTORY_INCOMPLETE",
    "The restored client operation namespace is incomplete.",
  );
  return t;
}

export function ownedOperation(
  state: WalletState,
  context: ClientContext,
  operationId: string,
): RequestRecord | null {
  return (
    operationHistory(state, context.clientId).requests.find(
      (record) =>
        record.ownerId === context.ownerId &&
        record.clientId === context.clientId &&
        record.operationId === operationId,
    ) ?? null
  );
}
