import type { BrowserWindow } from "electron";
import type { DesktopWalletProcess } from "./desktopWalletProcess.js";
import type { WalletApplicationVisibility } from "./desktopWalletApplicationVisibility.js";
import { walletControlReadSchema, walletControlMutationSchema, type WalletControlRead, type WalletControlMutation } from "@fcode/shared";

export interface DesktopWalletWindowOptions {
  connectDesktop?: () => Promise<void>;
  autoOpenExisting?: boolean;
  resourceDirectory: string;
  wallet: Pick<
    DesktopWalletProcess,
    | "start"
    | "list"
    | "inspectWallet"
    | "manage"
    | "lockForHostEvent"
    | "cancelHostInteraction"
    | "stateGeneration"
    | "onStateInvalidated"
    | "invalidateDisplayObservation"
  > & Partial<Pick<DesktopWalletProcess, "allowance">>;
  enterSensitiveUi: () => Promise<() => void>;
  authenticate: (reason: string) => Promise<void>;
  cancelAuthentication: () => void;
  locale: () => string;
  observeApplicationHide: (onHide: () => void) => WalletApplicationVisibility;
  selectClient?: (clientId: string, mode: "create" | "open", assertCurrent: () => void) => Promise<void>;
  paymentBroker?: Pick<DesktopWalletProcess["payments"], "subscribe" | "list" | "decide">;
  outboundBroker?: Pick<DesktopWalletProcess["outbound"], "subscribe" | "inspect" | "decide" | "pending" | "hasPending">;
  confirmGeneralRpc?: (window: BrowserWindow, networkId: string, candidate: { id: string; provider: string; endpoint: string }, signal: AbortSignal) => Promise<boolean>;
  migrateStorage?: (confirm: (summary: { records: number; domains: number }) => Promise<boolean>, signal?: AbortSignal) => Promise<boolean>;
  openGeneralManagement?: (initializeImport?: boolean) => Promise<Electron.MessagePortMain>;
  generalWallet?: {
    prepare(): Promise<void>;
    status(): Promise<unknown>;
    networks(): Promise<unknown>;
    probeRpc?(networkId: string, choice: string, signal?: AbortSignal): Promise<unknown>;
    balances(networkId: string, address: string, cacheScope: string, signal?: AbortSignal, rpcChoice?: string): Promise<unknown>;
    customBalances(networkId: string, address: string, cacheScope: string,
      assets: Array<{ contractAddress: string; expectedDecimals?: number }>, signal?: AbortSignal, rpcChoice?: string): Promise<unknown>;
    inspectToken(networkId: string, address: string, contractAddress: string, signal?: AbortSignal, rpcChoice?: string): Promise<unknown>;
    receive(networkId: string, address: string, assetId: string): Promise<unknown>;
    stop(): void;
  };
}

export function walletCommandRequiresAuthentication(action: string): boolean {
  return ["create_profile", "create_wallet", "unlock"].includes(action);
}

export type WalletWindowCommand =
  | { action: "status" }
  | { action: "presentation" }
  | { action: "open_profile" }
  | { action: "create_profile" }
  | { action: "create_wallet" }
  | { action: "set_default"; walletId: string }
  | { action: "lock"; walletId: string }
  | { action: "unlock"; walletId: string };
export type WalletSettingsCommand = WalletControlRead | WalletControlMutation;

/** First setup can finish across a replacement window; all other controls remain exclusive. */
export function walletControlBusy<T>(busy: ReadonlyMap<T, string>, window: T, action: string): boolean {
  const capacity = 8;
  return busy.size >= capacity || busy.has(window) || (busy.size > 0 &&
    !(action === "open_profile" && [...busy.values()].every((value) => value === "create_profile" || value === "open_profile")));
}

export function parseWalletWindowCommand(value: unknown): WalletWindowCommand | WalletSettingsCommand | null {
  const settings = walletControlReadSchema.safeParse(value);
  if (settings.success) return settings.data;
  const mutation = walletControlMutationSchema.safeParse(value);
  if (mutation.success) return mutation.data;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.action !== "string") return null;
  const keys = Object.keys(record).sort().join(",");
  if (
    keys === "action" &&
    ["status", "presentation", "open_profile", "create_profile", "create_wallet"].includes(String(record.action))
  ) {
    return { action: record.action } as WalletWindowCommand;
  }
  if (
    keys !== "action,walletId" ||
    !["set_default", "lock", "unlock"].includes(String(record.action)) ||
    typeof record.walletId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.walletId)
  )
    return null;
  return { action: record.action, walletId: record.walletId } as WalletWindowCommand;
}

export function assertWalletWindowSender(win: BrowserWindow | undefined, event: Electron.IpcMainInvokeEvent, expectedUrl: string,
  applicationHidden: () => boolean): asserts win is BrowserWindow {
  if (!win || win.isDestroyed() || !isTrustedWalletSender({
    sender: event.sender, expectedSender: win.webContents, frame: event.senderFrame, mainFrame: win.webContents.mainFrame,
    frameUrl: event.senderFrame?.url, expectedUrl, visible: !applicationHidden() && win.isVisible() && !win.isMinimized(),
  })) throw new Error("WALLET_UNTRUSTED_SOURCE");
}

export function isTrustedWalletSender(input: {
  sender: unknown;
  expectedSender: unknown;
  frame: unknown;
  mainFrame: unknown;
  frameUrl: string | undefined;
  expectedUrl: string;
  visible: boolean;
}): boolean {
  return (
    input.visible &&
    input.sender === input.expectedSender &&
    input.frame === input.mainFrame &&
    !!input.frame &&
    input.frameUrl === input.expectedUrl
  );
}

/** This session can load only the wallet's fixed local document and assets. */
export function isAllowedWalletResource(url: string, allowed: readonly string[]): boolean {
  return allowed.includes(url);
}

/** Exposes only safe display facts, never private wallet objects or exceptions. */
export function walletWindowItems(value: unknown): Array<{
  walletId: string;
  address: string;
  network: string;
  asset: string;
  isDefault: boolean;
  locked: boolean;
  unlockRemainingMs: number | null;
  recoveryRequired: boolean;
  signingPaused: boolean;
}> {
  if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid wallet list.");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Invalid wallet item.");
    const row = item as Record<string, unknown>;
    if (
      typeof row.walletId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.walletId) ||
      typeof row.address !== "string" ||
      !/^0x[0-9a-f]{40}$/i.test(row.address) ||
      typeof row.network !== "string" ||
      !/^eip155:[0-9]{1,20}$/.test(row.network) ||
      typeof row.asset !== "string" ||
      !/^0x[0-9a-f]{40}$/i.test(row.asset) ||
      typeof row.isDefault !== "boolean" ||
      typeof row.locked !== "boolean" ||
      (row.locked
        ? row.unlockRemainingMs !== null
        : row.unlockRemainingMs !== null && (!Number.isSafeInteger(row.unlockRemainingMs) ||
          (row.unlockRemainingMs as number) < 0 ||
          (row.unlockRemainingMs as number) > 900000)) ||
      typeof row.recoveryRequired !== "boolean" ||
      typeof row.signingPaused !== "boolean"
    )
      throw new Error("Invalid wallet item.");
    return {
      walletId: row.walletId,
      address: row.address,
      network: row.network,
      asset: row.asset,
      isDefault: row.isDefault,
      locked: row.locked,
      unlockRemainingMs: row.unlockRemainingMs as number | null,
      recoveryRequired: row.recoveryRequired,
      signingPaused: row.signingPaused,
    };
  });
}

/** Do not expose arbitrary system errors through the wallet renderer boundary. */
export function walletWindowError(error: unknown): string {
  const candidate =
    error && typeof error === "object" && "code" in error
      ? error.code
      : error instanceof Error
        ? error.message
        : "";
  return typeof candidate === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate)
    ? candidate
    : "WALLET_UNAVAILABLE";
}
