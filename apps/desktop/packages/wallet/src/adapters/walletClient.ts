import type { WalletRequests } from "../app/requests.js";
import type { ClientHandle } from "../app/sessions.js";
import type { X402RequestInput, RequestView } from "../domain/requestModel.js";
import type { DurableOperationAdapter } from "./durableOperations.js";
import { requireWallet } from "../domain/errors.js";
export interface WalletClientPort {
  request(input: X402RequestInput, trustedActionId: string, signal?: AbortSignal): Promise<RequestView>;
  lookupOperation(operationId: string): Promise<RequestView | null>;
  getRequest(requestId: string, waitMs?: number): Promise<RequestView>;
  reconcile(requestId: string): Promise<RequestView>;
  recoverResponse(requestId: string, signal?: AbortSignal): Promise<RequestView>;
  readResponse(requestId: string): AsyncIterable<Uint8Array>;
}
export function createWalletClient(
  requests: WalletRequests,
  handle: ClientHandle,
  journal: DurableOperationAdapter,
): WalletClientPort {
  return Object.freeze({
    async request(input: X402RequestInput, trustedActionId: string, signal?: AbortSignal) {
      const requestInput = structuredClone(input);
      const operation = await journal.prepareAnchored(trustedActionId, requestInput, {
        commit: checkpoint => requests.journalAnchors.commit(handle, checkpoint),
      });
      return requests.request(handle, requestInput, operation.operationId, signal);
    },
    async lookupOperation(id: string) {
      return requests.lookupOperation(handle, id);
    },
    async getRequest(id: string, waitMs = 0) {
      requireWallet(
        Number.isSafeInteger(waitMs) && waitMs >= 0 && waitMs <= 5000,
        "INVALID_REQUEST",
        "The request observation wait exceeds its limit.",
      );
      const deadline = performance.now() + waitMs;
      let state = requests.get(handle, id);
      while (state.transportStatus === "running" && performance.now() < deadline) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(100, deadline - performance.now())),
        );
        state = requests.get(handle, id);
      }
      return state;
    },
    async recoverResponse(id: string, signal?: AbortSignal) {
      return requests.recoverRetainedResponse(handle, id, signal);
    },
    async reconcile(id: string) {
      return requests.reconcile(handle, id);
    },
    async *readResponse(id: string) {
      const bytes = await requests.readResponse(handle, id);
      try {
        if (bytes.length === 0) requests.assertResponseReadable(handle, id);
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          const chunk = Uint8Array.from(
            bytes.subarray(offset, Math.min(offset + 65536, bytes.length)),
          );
          try {
            requests.assertResponseReadable(handle, id);
          } catch (error) {
            try {
              chunk.fill(0);
            } catch {
              // Preserve the access error if best-effort clearing fails.
            }
            throw error;
          }
          yield chunk;
        }
      } finally {
        try {
          bytes.fill(0);
        } catch {
          // Clearing cannot retract delivered chunks or guarantee physical erasure.
        }
      }
    },
  });
}
