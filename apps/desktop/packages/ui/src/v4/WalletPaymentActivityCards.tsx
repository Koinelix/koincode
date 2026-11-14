import { useEffect, useRef, useState } from "react";
import type { WalletPaymentActivity } from "@fcode/shared";
import { CheckIcon, ChevronDownIcon, CircleAlertIcon, CircleCheckIcon, Clock3Icon, CopyIcon, WalletIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { useFCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { unmatchedRestoredActivities, displayAmount, displayClientPrompt, displayResultArtifact } from "./walletPaymentActivityModel.js";

type Presented = (activity: WalletPaymentActivity) => Promise<boolean>;

type CopyState = "idle" | "copied" | "failed";

function PaymentDetail({ label, value, essential = false }: { label: string; value: string; essential?: boolean }) {
  const { intl } = useFCodeIntl();
  const [copyState, setCopyState] = useState<CopyState>("idle");
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [copyState]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  const copyLabel = intl.formatMessage({ id: "wallet.activity.copyField" }, { field: label });
  return (
    <div data-quote-essential={essential ? "true" : undefined} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-0.5 sm:grid-cols-[5.5rem_minmax(0,1fr)_auto]">
      <span className="col-span-2 text-ui-sm text-[var(--color-foreground-subtle)] sm:col-span-1">{label}</span>
      <span className="min-w-0 break-all font-mono text-ui-sm text-[var(--color-foreground-subtle)]">{value}</span>
      <button type="button" onClick={() => { void copy(); }} aria-label={copyLabel} title={copyLabel}
        className="inline-flex size-6 items-center justify-center rounded-md text-[var(--color-foreground-subtlest)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]">
        {copyState === "copied" ? <CheckIcon aria-hidden="true" className="size-3.5" /> : <CopyIcon aria-hidden="true" className="size-3.5" />}
      </button>
      {copyState !== "idle" ? <span role="status" className="col-span-full text-ui-sm text-[var(--color-foreground-subtle)]">
        {intl.formatMessage({ id: copyState === "copied" ? "wallet.activity.copied" : "wallet.activity.copyFailed" })}
      </span> : null}
    </div>
  );
}

const statusStyles = {
  quoted: { Icon: WalletIcon, color: "text-[var(--color-foreground-subtle)]" },
  pending: { Icon: Clock3Icon, color: "text-[var(--color-warning)]" },
  confirmed: { Icon: CircleCheckIcon, color: "text-[var(--color-success)]" },
  failed: { Icon: CircleAlertIcon, color: "text-[var(--color-destructive)]" },
  unknown: { Icon: CircleAlertIcon, color: "text-[var(--color-foreground-subtle)]" },
} as const;

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected || document.visibilityState !== "visible") return false;
  const essentials = element.querySelectorAll<HTMLElement>("[data-quote-essential]");
  if (!essentials.length) return false;
  return [...essentials].every((item) => {
    const rect = item.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.top < 0 || rect.left < 0 ||
        rect.bottom > window.innerHeight || rect.right > window.innerWidth) return false;
    for (let node: HTMLElement | null = item; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (node.hidden || node.inert || node.getAttribute("aria-hidden") === "true" ||
          style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return false;
      if (node !== item) {
        const clip = node.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (rect.left < clip.left || rect.right > clip.right)) return false;
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (rect.top < clip.top || rect.bottom > clip.bottom)) return false;
      }
    }
    return true;
  });
}

function WalletPaymentActivityCard({ activity, onPresented }: { activity: WalletPaymentActivity; onPresented?: Presented }) {
  const { intl } = useFCodeIntl();
  const ref = useRef<HTMLDivElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const walletUi = useOptionalPlatform()?.walletUi;
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const openWallet = async () => {
    if (!walletUi || opening) return;
    setOpening(true); setOpenFailed(false);
    try { await walletUi.open(); } catch { setOpenFailed(true); }
    finally { setOpening(false); }
  };
  useEffect(() => {
    if (activity.status !== "quoted" || !onPresented) return;
    let active = true, running = false, attempts = 0;
    const deadline = Date.now() + 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryPresent = () => {
      if (timer) clearTimeout(timer);
      if (!active || running || attempts >= 20 || Date.now() >= deadline) return;
      if (!ref.current || !isVisible(ref.current)) {
        timer = setTimeout(tryPresent, 500);
        return;
      }
      running = true;
      attempts += 1;
      void onPresented(activity).then((success) => {
        running = false;
        if (!active || success) return;
        if (attempts < 20) timer = setTimeout(tryPresent, 500);
        else console.warn("Wallet payment quote acknowledgement failed");
      });
    };
    tryPresent();
    window.addEventListener("scroll", tryPresent, true);
    window.addEventListener("resize", tryPresent);
    document.addEventListener("visibilitychange", tryPresent);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener("scroll", tryPresent, true);
      window.removeEventListener("resize", tryPresent);
      document.removeEventListener("visibilitychange", tryPresent);
    };
  }, [activity, onPresented]);
  const amount = displayAmount(activity);
  const asset = activity.assetSymbol || activity.asset || intl.formatMessage({ id: "wallet.activity.assetUnknown" });
  const quoted = activity.status === "quoted";
  const prompt = displayClientPrompt(activity.result?.clientPrompt);
  const artifacts = activity.result?.artifacts ?? [];
  const { Icon, color } = statusStyles[activity.status];
  const network = activity.network === "eip155:84532"
    ? intl.formatMessage({ id: "wallet.activity.baseSepolia" }, { network: activity.network }) : activity.network;
  const scopeKey = activity.authorizationScope && (quoted || activity.authorizationScope !== "none")
    ? `wallet.activity.${quoted ? "scope" : "used"}.${activity.authorizationScope}` : undefined;
  const target = activity.target ? <PaymentDetail essential={quoted} label={intl.formatMessage({ id: "wallet.activity.target" })} value={activity.target} /> : null;
  const recipient = activity.payTo ? <PaymentDetail essential={quoted} label={intl.formatMessage({ id: "wallet.activity.recipient" })} value={activity.payTo} /> : null;
  const hasPaymentDetails = Boolean(target || recipient || activity.paymentId);
  return (
    <div ref={ref} data-testid="wallet-payment-activity" className="w-full max-w-[38rem] min-w-0 overflow-hidden rounded-xl border border-[var(--color-border)] bg-background text-ui-base text-[var(--color-foreground)]">
      <div data-quote-essential={quoted ? "true" : undefined} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-3.5 pb-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-hover)] ${color}`}>
            <Icon aria-hidden="true" className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="font-medium leading-5" aria-live="polite">{intl.formatMessage({ id: activity.paymentId
              ? activity.status === "unknown" && activity.confirmationState
                ? `wallet.activity.confirmation.${activity.confirmationState}` : `wallet.activity.${activity.status}`
              : "wallet.activity.unavailable" })}</div>
            {network ? <div className="mt-0.5 break-all text-ui-sm text-[var(--color-foreground-subtle)]">{network}</div> : null}
          </div>
        </div>
        <span className="min-w-0 break-all text-right text-ui-lg font-semibold tabular-nums leading-6">
          {amount ? `${amount.amount} ${amount.atomic ? `${intl.formatMessage({ id: "wallet.activity.atomicUnits" })} ` : ""}${asset}` : intl.formatMessage({ id: "wallet.activity.amountUnknown" })}
        </span>
      </div>
      {scopeKey ? <div data-quote-essential={quoted ? "true" : undefined} className="px-4 pb-3 text-ui-sm leading-5 text-[var(--color-foreground-subtle)]">{intl.formatMessage({ id: scopeKey })}</div> : null}
      {!quoted && (prompt || artifacts.length > 0) ? <div className="flex flex-col gap-2 border-t border-[var(--color-border)] px-4 py-3 text-ui-sm">
        {prompt ? <div className="min-w-0"><span className="text-[var(--color-foreground-subtle)]">{intl.formatMessage({ id: "wallet.activity.clientPrompt" })}: </span><span className="break-words whitespace-pre-wrap">{prompt}</span></div> : null}
        {artifacts.map(artifact => {
          const display = displayResultArtifact(artifact.verifiedMediaType, artifact.bytes);
          return <div key={artifact.artifactId} className="text-[var(--color-foreground-subtle)]">{intl.formatMessage({ id: "wallet.activity.imageInfo" })}: {[display.format, display.size].filter(Boolean).join(" · ") || intl.formatMessage({ id: "wallet.activity.amountUnknown" })}</div>;
        })}
      </div> : null}
      {quoted && (target || recipient) ? <div className="flex flex-col gap-2 border-t border-[var(--color-border)] px-4 py-3">{target}{recipient}</div> : null}
      {quoted && onPresented && walletUi ? <div className="flex flex-col items-start gap-2 border-t border-[var(--color-border)] px-4 py-3">
        <p className="text-ui-sm text-[var(--color-foreground-subtle)]">{intl.formatMessage({ id: "wallet.activity.confirmInWallet" })}</p>
        <button type="button" disabled={opening} onClick={() => { void openWallet(); }}
          className="rounded-lg bg-[var(--color-foreground)] px-3 py-2 text-ui-sm font-medium text-[var(--color-background)] disabled:opacity-50">
          {intl.formatMessage({ id: opening ? "wallet.opening" : "wallet.activity.openConfirmation" })}
        </button>
        {openFailed ? <p role="alert" className="text-ui-sm text-destructive">{intl.formatMessage({ id: "wallet.activity.openFailed" })}</p> : null}
      </div> : null}
      {activity.status === "unknown" && activity.confirmationState ? <p className="px-4 pb-3 text-ui-sm text-[var(--color-foreground-subtle)]">
        {intl.formatMessage({ id: "wallet.activity.confirmationEnded" })}
      </p> : null}
      {hasPaymentDetails ? <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
        <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 border-t border-[var(--color-border)] px-4 py-2.5 text-left text-ui-sm text-[var(--color-foreground-subtle)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]">
          <span>{intl.formatMessage({ id: detailsOpen ? "wallet.activity.hideDetails" : "wallet.activity.showDetails" })}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-[var(--color-border)]">
          <div className="flex flex-col gap-2 px-4 py-3">
            {!quoted ? <>{target}{recipient}</> : null}
            {activity.paymentId ? <PaymentDetail label={intl.formatMessage({ id: "wallet.activity.paymentId" })} value={activity.paymentId} /> : null}
          </div>
        </CollapsibleContent>
      </Collapsible> : null}
    </div>
  );
}

export function WalletPaymentActivityCards({ activities, onPresented }: { activities: readonly WalletPaymentActivity[]; onPresented?: Presented }) {
  if (!activities.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {activities.map((activity) => <WalletPaymentActivityCard key={`${activity.invocationId}:${activity.paymentId}`} activity={activity} onPresented={onPresented} />)}
    </div>
  );
}

/** A restore failure is not a payment record and carries no financial status. */
export function WalletPaymentActivityRestoreNotice({ onRetry }: { onRetry: () => void }) {
  const { intl } = useFCodeIntl();
  return <div role="status" data-testid="wallet-payment-restore-failure" className="mx-4 my-2 flex flex-wrap items-center gap-2 text-ui-sm text-[var(--color-foreground-subtle)]">
    <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0" />
    <span>{intl.formatMessage({ id: "wallet.activity.restoreFailed" })}</span>
    <button type="button" onClick={onRetry} className="rounded-md px-2 py-1 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]">
      {intl.formatMessage({ id: "wallet.activity.restoreRetry" })}
    </button>
  </div>;
}

/** This separate readonly area cannot acknowledge a quote or manufacture a tool row. */
export function RestoredWalletPaymentActivities({ activities, rows }: {
  activities: readonly WalletPaymentActivity[];
  rows: readonly { kind: string; turnId: string; runtimeTurnId?: string; toolCallId?: string }[];
}) {
  const { intl } = useFCodeIntl();
  const restored = unmatchedRestoredActivities(activities, rows);
  if (!restored.length) return null;
  return <section className="mx-auto my-3 flex w-full min-w-0 flex-col gap-2 px-4" aria-label={intl.formatMessage({ id: "wallet.activity.restored" })}>
    <p className="text-ui-sm text-[var(--color-foreground-subtle)]">{intl.formatMessage({ id: "wallet.activity.restored" })}</p>
    <WalletPaymentActivityCards activities={restored} />
  </section>;
}
