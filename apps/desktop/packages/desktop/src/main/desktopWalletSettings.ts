import {
  walletInspectionSchema,
  type WalletControlRead,
  type WalletControlMutation,
  type WalletInspection,
} from "@fcode/shared";
import type { DesktopWalletProcess } from "./desktopWalletProcess.js";

type Wallet = Pick<DesktopWalletProcess, "inspectWallet" | "manage">;
const MAX_INSPECTION_BYTES = 64 * 1024;

export async function applyWalletSettings(wallet: Wallet, command: WalletControlMutation, assertCurrent: () => void,
  selectClient?: (clientId: string, mode: "create" | "open", assertCurrent: () => void) => Promise<void>): Promise<void> {
  const selection = await executeWalletSettings(wallet, command, assertCurrent);
  if (selection) {
    if (!selectClient) throw new Error("WALLET_CLIENT_SELECTION_UNAVAILABLE");
    await selectClient(selection.clientId, selection.mode, assertCurrent);
  }
  assertCurrent();
}

export async function inspectWalletSettings(
  wallet: Wallet,
  command: WalletControlRead,
): Promise<WalletInspection> {
  const raw = await wallet.inspectWallet(command.walletId, command.section, command.offset, command.displayOnly);
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_INSPECTION_BYTES)
    throw new Error("WALLET_INVALID_RESPONSE");
  const value = walletInspectionSchema.parse(raw);
  if (
    value.wallet.walletId !== command.walletId ||
    value.section !== command.section ||
    value.offset !== command.offset ||
    (value.nextOffset !== null &&
      (value.records.length === 0 || value.nextOffset !== value.offset + value.records.length))
  )
    throw new Error("WALLET_INVALID_RESPONSE");
  return value;
}

/** The caller authenticates and rechecks its live trusted window around every asynchronous step. */
export async function executeWalletSettings(
  wallet: Wallet,
  command: WalletControlMutation,
  assertCurrent: () => void,
): Promise<{ clientId: string; mode: "create" | "open" } | undefined> {
  assertCurrent();
  if (command.action === "set_limits") {
    await wallet.manage({ action: "limits", walletId: command.walletId, limits: command.limits });
  } else {
    const section = command.action === "revoke_grant" ? "grants" : "clients";
    const inspection = await inspectWalletSettings(wallet, {
      action: "inspect_wallet",
      walletId: command.walletId,
      section,
      offset: "offset" in command ? command.offset : 0,
    });
    assertCurrent();
    if (command.action === "register_client") {
      const result = await wallet.manage({
        action: "register_client",
        kind: command.kind,
        subjectIds: [inspection.wallet.subjectId],
      });
      assertCurrent();
      if (command.kind === "internal") {
        if (!result || typeof result !== "object" || !("clientId" in result) ||
          typeof result.clientId !== "string" || !/^[0-9a-f-]{36}$/.test(result.clientId))
          throw new Error("WALLET_INVALID_RESPONSE");
        return { clientId: result.clientId, mode: "create" };
      }
    } else if (command.action === "use_client") {
      if (inspection.section !== "clients" || !inspection.records.some((row) =>
        row.clientId === command.clientId && row.active && row.kind === "internal")) throw new Error("WALLET_INVALID_REQUEST");
      return { clientId: command.clientId, mode: "open" };
    } else if (command.action === "revoke_client") {
      if (
        inspection.section !== "clients" ||
        !inspection.records.some((row) => row.clientId === command.clientId)
      )
        throw new Error("WALLET_INVALID_REQUEST");
      await wallet.manage({ action: "revoke_client", clientId: command.clientId });
    } else {
      if (
        inspection.section !== "grants" ||
        !inspection.records.some((row) => row.grantId === command.grantId)
      )
        throw new Error("WALLET_INVALID_REQUEST");
      await wallet.manage({ action: "revoke_grant", grantId: command.grantId });
    }
  }
  assertCurrent();
}
