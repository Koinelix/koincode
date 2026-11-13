import { useEffect, useRef, useState } from "react";
import type { RemoteHostManagementClient, RemoteHostSummary, RemoteTestResult } from "@fcode/shared";
import { RemoteHostTrustDialog } from "@/settings/RemoteHostTrustDialog.js";
import { useRemoteManagementOperation } from "./useRemoteManagementOperation.js";
import { connectRemoteHosts } from "./connectRemoteHosts.js";

/** Settings and chat share one explicit, cancelable connection and fingerprint flow. */
export function useRemoteHostConnection(client: RemoteHostManagementClient | undefined, key: string) {
  const operation = useRemoteManagementOperation(client, key);
  const active = useRef<{ key: string; controller: AbortController; decline?: () => void } | undefined>(undefined);
  const [state, setState] = useState<{ key: string; busy: boolean; challenge?: RemoteTestResult; accept?: (value: boolean) => void }>({ key, busy: false });
  useEffect(() => () => {
    const current = active.current;
    if (current?.key === key) { current.controller.abort(); current.decline?.(); }
  }, [client, key]);
  const cancel = async () => {
    const current = active.current;
    if (current?.key === key) { current.controller.abort(); current.decline?.(); }
    await operation.cancel();
  };
  const run = async (hosts: RemoteHostSummary[]) => {
    if (!client) throw new Error("Remote Host management is unavailable.");
    if (active.current && !active.current.controller.signal.aborted) throw new Error("A connection is already being prepared.");
    const current = { key, controller: new AbortController(), decline: undefined as (() => void) | undefined };
    active.current = current;
    setState({ key, busy: true });
    try {
      return await connectRemoteHosts({ client, hosts, signal: current.controller.signal,
        test: (host) => operation.run("testConnections", { targets: [{ hostId: host.hostId, securityRevision: host.securityRevision }] }),
        confirm: (challenge) => new Promise<boolean>((resolve) => {
          current.decline = () => resolve(false);
          setState({ key, busy: true, challenge, accept: resolve });
        }),
      });
    } finally {
      if (active.current === current) {
        active.current = undefined;
        setState((previous) => previous.key === key ? { key, busy: false } : previous);
      }
    }
  };
  const answer = (accept: boolean) => {
    if (state.key !== key || active.current?.key !== key || active.current.controller.signal.aborted) return;
    state.accept?.(accept);
    setState({ key, busy: true });
  };
  return { run, cancel, busy: state.key === key && state.busy,
    dialog: state.key === key && state.challenge?.challenge ? <RemoteHostTrustDialog challenge={state.challenge.challenge}
      changed={state.challenge.error?.code === "host_key_changed"} pending={false}
      onAccept={() => answer(true)} onClose={() => answer(false)} /> : null };
}
