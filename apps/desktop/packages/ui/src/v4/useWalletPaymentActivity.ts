import { useCallback, useEffect, useRef, useState } from "react";
import type { IPlatformService, WalletPaymentActivity } from "@fcode/shared";
import type { ConversationRow } from "@fcode/shared/fcode-protocol-v4";
import { mergeActivity, QuoteAcknowledgements, quotePresentationReadiness, validActivity } from "./walletPaymentActivityModel.js";

import { useWalletPaymentRefresh } from "./useWalletPaymentRefresh.js";

type ActivityState = { scope: string; items: WalletPaymentActivity[] };

/** Display only events delivered by the desktop host for the active authenticated scope. */
export function useWalletPaymentActivity(
  wallet: IPlatformService["walletUi"] | undefined,
  workspaceKey: string,
  sessionId: string | null | undefined,
  rows: readonly ConversationRow[],
  active = true,
): { activities: WalletPaymentActivity[]; onPresented: (activity: WalletPaymentActivity) => Promise<boolean>; restoreFailed: boolean; onRestoreRetry: () => void } {
  const scopeKey = sessionId ? JSON.stringify([workspaceKey, sessionId]) : "";
  const [state, setState] = useState<ActivityState>({ scope: "", items: [] });
  const [restoreFailure, setRestoreFailure] = useState("");
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const onRestoreRetry = useCallback(() => setRestoreAttempt(value => value + 1), []);
  const latest = useRef({ scopeKey, state, rows });
  latest.current = { scopeKey, state, rows };
  const acknowledgements = useRef(new QuoteAcknowledgements());

  useEffect(() => {
    if (!wallet?.onPaymentActivity || !wallet.listPaymentActivity || !sessionId) return;
    const scope = { workspaceKey, sessionId };
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setRestoreFailure("");
    setState(previous => previous.scope === scopeKey ? previous : { scope: scopeKey, items: [] });
    const accept = (item: WalletPaymentActivity) => {
      if (!current || !validActivity(item, scope)) return;
      setState((previous) => {
        const base = previous.scope === scopeKey ? previous : { scope: scopeKey, items: [] };
        return { scope: scopeKey, items: mergeActivity(base.items, item) };
      });
    };
    const unsubscribe = wallet.onPaymentActivity(accept);
    const delays = [300, 1000, 3000];
    const restore = async (attempt: number): Promise<void> => {
      try {
        const items = await wallet.listPaymentActivity!(scope);
        if (!current) return;
        if (!Array.isArray(items)) throw new Error("WALLET_ACTIVITY_INVALID");
        for (const item of items) accept(item);
        setRestoreFailure("");
      } catch {
        if (!current) return;
        const delay = delays[attempt];
        if (delay === undefined) setRestoreFailure(scopeKey);
        else timer = setTimeout(() => { void restore(attempt + 1); }, delay);
      }
    };
    void restore(0);
    return () => { current = false; if (timer) clearTimeout(timer); unsubscribe(); };
  }, [wallet, workspaceKey, sessionId, scopeKey, restoreAttempt]);

  const onPresented = useCallback(async (activity: WalletPaymentActivity): Promise<boolean> => {
    const current = latest.current;
    if (!wallet?.ackPaymentActivity || !sessionId || current.scopeKey !== scopeKey || current.state.scope !== scopeKey) return true;
    const readiness = quotePresentationReadiness(activity, { workspaceKey, sessionId }, current.state.items, current.rows);
    if (readiness !== "ready") return readiness === "stale";
    const key = JSON.stringify([scopeKey, activity.invocationId, activity.revision]);
    return acknowledgements.current.acknowledge(key, () => wallet.ackPaymentActivity!({ invocationId: activity.invocationId, revision: activity.revision }));
  }, [wallet, workspaceKey, sessionId, scopeKey]);

  const acceptRefresh = useCallback((scope: string, item: WalletPaymentActivity) => {
    if (latest.current.scopeKey !== scope) return;
    setState(previous => previous.scope === scope ? { scope, items: mergeActivity(previous.items, item) } : previous);
  }, []);
  const activities = state.scope === scopeKey ? state.items : [];
  useWalletPaymentRefresh(wallet, workspaceKey, sessionId, scopeKey, activities, active, acceptRefresh);
  return { activities, onPresented, restoreFailed: !!scopeKey && restoreFailure === scopeKey, onRestoreRetry };
}
