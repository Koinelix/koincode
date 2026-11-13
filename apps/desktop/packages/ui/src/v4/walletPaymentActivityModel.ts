import type { WalletPaymentActivity } from "@fcode/shared";

export type ActivityScope = { workspaceKey: string; sessionId: string };

export function validActivity(value: WalletPaymentActivity, scope: ActivityScope): boolean {
  return value !== null && typeof value === "object" && value.version === 1 &&
    value.workspaceKey === scope.workspaceKey && value.sessionId === scope.sessionId &&
    [value.turnId, value.toolCallId, value.invocationId].every(
      (part) => typeof part === "string" && part.length > 0 && part.length <= 256,
    ) && (value.paymentId === undefined || (typeof value.paymentId === "string" && value.paymentId.length > 0 && value.paymentId.length <= 256)) &&
    (value.paymentId !== undefined || value.status === "unknown") &&
    (value.authorizationScope === undefined || ["once", "session", "persistent", "none"].includes(value.authorizationScope)) &&
    (value.confirmationState === undefined || ["expired", "closed"].includes(value.confirmationState)) &&
    (value.target === undefined || (typeof value.target === "string" && value.target.length <= 8192 && safeTarget(value.target))) &&
    (value.restored === undefined || value.restored === true && value.status !== "quoted") &&
    Number.isSafeInteger(value.revision) && value.revision > 0 &&
    ["quoted", "pending", "confirmed", "failed", "unknown"].includes(value.status);
}

/** A quote may be acknowledged only when the complete validated price can be shown. */
export function displayableQuote(value: WalletPaymentActivity): boolean {
  return value.status === "quoted" &&
    typeof value.amountAtomic === "string" && /^[1-9][0-9]{0,77}$/.test(value.amountAtomic) &&
    Number.isInteger(value.decimals) && value.decimals !== undefined && value.decimals >= 0 && value.decimals <= 36 &&
    typeof value.assetSymbol === "string" && /^[A-Za-z0-9]{1,16}$/.test(value.assetSymbol) &&
    typeof value.asset === "string" && /^0x[0-9a-f]{40}$/i.test(value.asset) &&
    typeof value.payTo === "string" && /^0x[0-9a-f]{40}$/i.test(value.payTo) &&
    typeof value.network === "string" && value.network.length > 0 && value.network.length <= 100 &&
    typeof value.target === "string" && safeTarget(value.target) &&
    value.authorizationScope !== undefined && ["once", "session", "persistent", "none"].includes(value.authorizationScope);
}

export function quotePresentationReadiness(
  activity: WalletPaymentActivity,
  scope: ActivityScope,
  items: readonly WalletPaymentActivity[],
  rows: readonly PaymentToolRow[],
): "stale" | "waiting" | "ready" {
  if (!validActivity(activity, scope) || !displayableQuote(activity) ||
      !items.some((item) => item.invocationId === activity.invocationId && item.paymentId === activity.paymentId &&
        item.revision === activity.revision && item.status === "quoted")) return "stale";
  return rows.some((row) => activityMatchesToolCall(activity, row)) ? "ready" : "waiting";
}

/** Serialize confirmations per invocation while allowing distinct concurrent quotes. */
export class QuoteAcknowledgements {
  private readonly inFlight = new Set<string>();
  private readonly completed = new Set<string>();

  async acknowledge(key: string, send: () => Promise<void>): Promise<boolean> {
    if (this.completed.has(key)) return true;
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    try {
      await send();
      this.completed.add(key);
      return true;
    } catch {
      return false;
    } finally {
      this.inFlight.delete(key);
    }
  }
}

function safeTarget(value: string): boolean {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password &&
      !url.search && !url.hash && value === url.origin + url.pathname;
  } catch { return false; }
}

export function mergeActivity(items: WalletPaymentActivity[], value: WalletPaymentActivity): WalletPaymentActivity[] {
  const previous = items.find((item) => item.invocationId === value.invocationId && item.paymentId === value.paymentId);
  if (previous && previous.revision >= value.revision) return items;
  return [...items.filter((item) => item.invocationId !== value.invocationId || item.paymentId !== value.paymentId), value];
}

type PaymentToolRow = { kind: string; turnId: string; runtimeTurnId?: string; toolCallId?: string };

/** Product turn IDs differ from runtime turn IDs; only the trusted projection can bind them. */
export function activityMatchesToolCall(activity: WalletPaymentActivity, row: PaymentToolRow): boolean {
  return row.kind === "toolCall" && row.runtimeTurnId === activity.turnId &&
    row.toolCallId === activity.toolCallId;
}

/** Match host-owned facts to one exact tool invocation, not to model-generated images. */
export function activityForToolCall(
  items: readonly WalletPaymentActivity[], row: PaymentToolRow,
): WalletPaymentActivity[] {
  return items.filter((item) => activityMatchesToolCall(item, row));
}

/** Every activity stays in its owning turn, including the visible quote awaiting confirmation. */
export function activityForTurn(
  items: readonly WalletPaymentActivity[], rows: readonly PaymentToolRow[],
): WalletPaymentActivity[] {
  return items.filter((item) => rows.some((row) => activityMatchesToolCall(item, row)));
}

export function displayAmount(activity: WalletPaymentActivity): { amount: string; atomic: boolean } | null {
  const value = activity.amountAtomic;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value)) return null;
  const decimals = activity.decimals;
  if (!Number.isInteger(decimals) || decimals === undefined || decimals < 0 || decimals > 36) {
    return { amount: value, atomic: true };
  }
  if (decimals === 0) return { amount: value, atomic: false };
  const padded = value.padStart(decimals + 1, "0");
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return { amount: padded.slice(0, -decimals) + (fraction ? `.${fraction}` : ""), atomic: false };
}

/** Client-reported text is descriptive only and must never be treated as payment evidence. */
export function displayClientPrompt(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 6000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
      new TextEncoder().encode(value).byteLength > 6000) return undefined;
  return value;
}

/** Only formats a media type verified by the host, without guessing from a name. */
export function displayResultArtifact(mediaType: unknown, byteLength: unknown): { format?: string; size?: string } {
  const formats: Record<string, string> = { "image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WebP" };
  const format = typeof mediaType === "string" ? formats[mediaType] : undefined;
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength <= 0)
    return format ? { format } : {};
  const size = byteLength < 1024 ? `${byteLength} B` : byteLength < 1024 * 1024
    ? `${(byteLength / 1024).toFixed(2)} KiB` : `${(byteLength / (1024 * 1024)).toFixed(2)} MiB`;
  return { ...(format ? { format } : {}), size };
}

/** Verified recovered records remain visible without trusting synthetic transcript turns. */
export function unmatchedRestoredActivities(items: readonly WalletPaymentActivity[], rows: readonly PaymentToolRow[]): WalletPaymentActivity[] {
  return items.filter(item => item.restored === true && item.status !== "quoted" &&
    !rows.some(row => activityMatchesToolCall(item, row)));
}
