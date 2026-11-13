/** Private main-to-wallet utility process messages. Never exposed to a renderer or model. */
export type WalletStartMode = "open" | "create" | "resume_setup" | "import_setup" | "storage_maintenance";
export type WalletControlCommand =
  | { action: "save_credential"; clientId: string; origin: string; path: string; headerName: "authorization" | "x-api-key"; value: string }
  | { action: "revoke_credential"; credentialRef: string }
  | { action: "create"; network: "eip155:84532" | "eip155:8453" }
  | { action: "default"; walletId: string }
  | { action: "resume_signing"; walletId: string }
  | {
      action: "limits";
      walletId: string;
      limits: {
        enabled: boolean;
        maxPerPaymentAtomic: string;
        maxRolling24hAtomic: string;
        maxCumulativeAtomic: string;
      };
    }
  | { action: "register_client"; kind: "internal" | "external"; subjectIds: string[] }
  | { action: "revoke_client"; clientId: string }
  | { action: "revoke_grant"; grantId: string }
  | { action: "unlock"; walletId: string; scope?: "application"; durationMs?: number; idleMs?: number }
  | { action: "lock"; walletId?: string };
export type WalletAllowanceCommand =
  | { action: "allowance_status"; walletId: string }
  | { action: "allowance_preview"; walletId: string; amount: string }
  | { action: "allowance_confirm"; walletId: string; previewId: string }
  | { action: "allowance_resend"; walletId: string; hash: string };

export function parseAllowanceCommand(value: unknown): WalletAllowanceCommand | undefined {
  if (!value || typeof value !== "object") return;
  const r = value as Record<string, unknown>, keys = Object.keys(r).sort().join();
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  if (typeof r.walletId !== "string" || !uuid.test(r.walletId)) return;
  const walletId = r.walletId;
  if (r.action === "allowance_status" && keys === "action,walletId") return { action: r.action, walletId };
  if (r.action === "allowance_preview" && keys === "action,amount,walletId" && typeof r.amount === "string" && /^(0|[1-9][0-9]{0,77})$/.test(r.amount))
    return { action: r.action, walletId, amount: r.amount };
  if (r.action === "allowance_confirm" && keys === "action,previewId,walletId" && typeof r.previewId === "string" && uuid.test(r.previewId))
    return { action: r.action, walletId, previewId: r.previewId };
  if (r.action === "allowance_resend" && keys === "action,hash,walletId" && typeof r.hash === "string" && /^0x[0-9a-f]{64}$/.test(r.hash))
    return { action: r.action, walletId, hash: r.hash };
}
export type WalletProcessRequest =
  | { id: string; type: "wallet-allowance"; command: WalletAllowanceCommand }
  // The first start must also transfer exactly one dedicated parent-lifetime port.
  | { id: string; type: "start"; mode: WalletStartMode; keychainHelper: string }
  | { id: string; type: "storage-plan" }
  | { id: string; type: "storage-apply"; token: string }
  | { id: string; type: "list" }
  // Dedicated private setup/export connection; never passed to SDK or model ports.
  | { id: string; type: "general-connect" }
  | { id: string; type: "desktop-connect" }
  | { id: string; type: "inspect-wallet" | "inspect-wallet-display"; walletId: string; section: "clients" | "grants" | "payments"; offset: number }
  // Main transfers one private data endpoint after selecting a registered internal client/chat.
  | { id: string; type: "host-connect"; clientId: string; chatId: string; mode: "create" | "open"; connectionId?: string; paymentUi?: true; hostGrantScope?: string }
  | { id: string; type: "host-disconnect"; connectionId: string }
  | { id: string; type: "host-approve-destination"; connectionId: string; requestId: string; directory: string; name: string }
  | { id: string; type: "payment-decision"; approvalId: string; generation: string; choice: "deny" | "once" | "session" | "persistent" | "continue"; authenticated?: boolean }
  | { id: string; type: "manage"; command: WalletControlCommand }
  | { id: string; type: "outbound-inspect"; approvalId: string; generation: string; offset: number }
  | {
      id: string;
      type: "outbound-decision";
      approvalId: string;
      generation: string;
      allow: boolean;
      durationMs: number;
    }
  | { id: string; type: "outbound-revoke"; clientId: string; operationId: string }
  | { id: string; type: "outbound-clear" }
  | { id: string; type: "stop" };
export type WalletProcessReply =
  | { id: string; type: "reply"; ok: true; value: unknown }
  | { id: string; type: "reply"; ok: false; code: string };
export const WALLET_IPC_MAX_BYTES = 128 * 1024;
export function isWalletMessage(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= WALLET_IPC_MAX_BYTES;
  } catch {
    return false;
  }
}
