import type { WalletState } from "./state.js";
import type { RequestStore } from "./requestStore.js";
// Limited to synchronous request-state transitions with no asynchronous secret writes.
// Classify observe inside the owner queue before invalidating any live payment capability.
export async function requestControlMutation<T>(
  store: RequestStore,
  reduce: (state: WalletState, beginChange: () => void) => T,
): Promise<T> {
  let end: (() => void) | undefined;
  try {
    return await store.ctx.state.mutate((state) =>
      reduce(state, () => {
        if (!end) {
          end = store.ctx.fence.beginControl();
          store.ctx.unlocks.invalidatePending();
        }
      }),
    );
  } finally {
    end?.();
  }
}
