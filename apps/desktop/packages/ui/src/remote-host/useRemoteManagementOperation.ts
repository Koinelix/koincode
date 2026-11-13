import { useEffect, useRef, useState } from "react";
import type { RemoteCancellableManagementMethod, RemoteHostManagementClient, RemoteHostManagementInput } from "@fcode/shared";

/** Cancellation is scoped to the captured UI identity and acknowledged by the original request. */
export function useRemoteManagementOperation(client: RemoteHostManagementClient | undefined, key: string) {
  const active = useRef(new Map<string, { key: string; client: RemoteHostManagementClient }>());
  const [state, setState] = useState({ key, operationId: "", cancelRequested: false });
  const cancel = async () => {
    const operations = [...active.current].filter(([, item]) => item.key === key);
    await Promise.all(operations.map(async ([operationId, item]) => {
      await item.client.request("cancelManagementOperation", { operationId });
      setState((previous) => previous.key === key && previous.operationId === operationId ? { ...previous, cancelRequested: true } : previous);
    }));
  };
  useEffect(() => () => {
    for (const [operationId, item] of active.current) if (item.key === key) {
      void item.client.request("cancelManagementOperation", { operationId }).catch(() => { /* The broker may already have stopped. */ });
    }
  }, [key, client]);
  const run = async <M extends RemoteCancellableManagementMethod>(method: M, input: Omit<RemoteHostManagementInput<M>, "operationId">) => {
    if (!client) throw new Error("Remote Host management is unavailable.");
    if ([...active.current.values()].some((item) => item.key === key)) throw new Error("A management preparation is already running.");
    const operationId = crypto.randomUUID(); active.current.set(operationId, { key, client });
    setState({ key, operationId, cancelRequested: false });
    try { return await client.request(method, { ...input, operationId } as RemoteHostManagementInput<M>); }
    finally {
      active.current.delete(operationId);
      setState((previous) => previous.key === key && previous.operationId === operationId ? { key, operationId: "", cancelRequested: false } : previous);
    }
  };
  return { run, cancel, active: state.key === key && Boolean(state.operationId), cancelRequested: state.key === key && state.cancelRequested };
}
