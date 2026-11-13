import { useCallback, useEffect, useRef, useState } from "react";
import type { IPlatformService, WalletPaymentActivity } from "@fcode/shared";
import { validActivity } from "./walletPaymentActivityModel.js";

const DELAYS = [5_000, 15_000, 30_000, 60_000, 120_000, 180_000];
type Budget = { attempts: number; next: number };

/** A bounded lookup scheduler for existing pending payments; it never submits a payment. */
export function useWalletPaymentRefresh(wallet: IPlatformService["walletUi"] | undefined,
  workspaceKey: string, sessionId: string | null | undefined, scopeKey: string,
  activities: readonly WalletPaymentActivity[], active: boolean,
  accept: (scope: string, activity: WalletPaymentActivity) => void) {
  const latest = useRef({ scopeKey, activities, active });
  latest.current = { scopeKey, activities, active };
  const [failureState, setFailureState] = useState<{ scope: string; ids: string[] }>({ scope: "", ids: [] });
  const wake = useRef<(() => void) | undefined>(undefined);
  const budgets = useRef(new Map<string, Budget>());
  const running = useRef(new Map<string, Promise<boolean>>());
  const refresh = useCallback((activity: WalletPaymentActivity): Promise<boolean> => {
    if (!wallet?.listPaymentActivity || !sessionId || latest.current.scopeKey !== scopeKey ||
        !validActivity(activity, { workspaceKey, sessionId }) || !activity.paymentId ||
        !latest.current.activities.some(item => item.invocationId === activity.invocationId && item.paymentId === activity.paymentId))
      return Promise.resolve(false);
    const key = JSON.stringify([scopeKey, activity.invocationId, activity.paymentId]);
    const existing = running.current.get(key);
    if (existing) return existing;
    const report = (failed: boolean) => {
      if (latest.current.scopeKey !== scopeKey) return;
      setFailureState(previous => {
        const ids = new Set(previous.scope === scopeKey ? previous.ids : []);
        if (failed) ids.add(activity.invocationId); else ids.delete(activity.invocationId);
        return { scope: scopeKey, ids: [...ids] };
      });
    };
    const work = Promise.resolve().then(() => wallet.listPaymentActivity!({ workspaceKey, sessionId, refresh: true, paymentId: activity.paymentId })).then(items => {
      if (latest.current.scopeKey !== scopeKey) return false;
      if (!Array.isArray(items)) { report(true); return false; }
      const item = items.find(value => validActivity(value, { workspaceKey, sessionId }) &&
        value.invocationId === activity.invocationId && value.paymentId === activity.paymentId);
      if (!item) { report(true); return false; }
      accept(scopeKey, item);
      report(false);
      return true;
    }).catch(() => { report(true); return false; }).finally(() => {
      running.current.delete(key);
      if (latest.current.scopeKey === scopeKey) wake.current?.();
    });
    running.current.set(key, work);
    return work;
  }, [wallet, workspaceKey, sessionId, scopeKey, accept]);

  useEffect(() => {
    if (!active || !wallet?.listPaymentActivity || !sessionId) return;
    let current = true, timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      if (!current || document.visibilityState !== "visible") return;
      const now = Date.now();
      let next = Infinity;
      for (const activity of latest.current.activities) {
        if (activity.status !== "pending" || !activity.paymentId) continue;
        const key = JSON.stringify([scopeKey, activity.invocationId, activity.paymentId]);
        let budget = budgets.current.get(key);
        if (!budget) { budget = { attempts: 0, next: now + DELAYS[0]! }; budgets.current.set(key, budget); }
        if (budget.attempts >= DELAYS.length || running.current.has(key)) continue;
        if (budget.next <= now) {
          budget.attempts++;
          budget.next = now + (DELAYS[budget.attempts] ?? 0);
          void refresh(activity);
        } else next = Math.min(next, budget.next);
      }
      if (Number.isFinite(next)) timer = setTimeout(schedule, Math.max(1, next - Date.now()));
    };
    wake.current = schedule;
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => {
      current = false;
      if (wake.current === schedule) wake.current = undefined;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [active, wallet, sessionId, scopeKey, activities, refresh]);
  return { refresh, failedInvocations: failureState.scope === scopeKey ? failureState.ids : [] };
}
