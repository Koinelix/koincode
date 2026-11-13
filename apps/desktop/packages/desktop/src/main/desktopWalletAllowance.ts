import { dialog, type BrowserWindow } from "electron";
import { type DesktopWalletWindowOptions, walletControlBusy } from "./desktopWalletWindowPolicy.js";
import type { WalletAllowanceCommand } from "./desktopWalletProtocol.js";

function display(raw: string, decimals: number) {
  const digits = BigInt(raw).toString().padStart(decimals + 1, "0");
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return digits.slice(0, -decimals) + (fraction ? "." + fraction : "");
}

/** Preview terms come from the wallet utility. The renderer can submit only their single-use identifier. */
export function createAllowanceHandler(options: DesktopWalletWindowOptions, messages: () => Promise<Record<string, string>>,
  assertCurrent: (win: BrowserWindow, generation: number) => void, busy: Map<BrowserWindow, string>) {
  let preview: { win: BrowserWindow; generation: number; walletId: string; id: string; detail: string } | undefined;
  return async (command: WalletAllowanceCommand, win: BrowserWindow, generation: number, profileOpen: boolean) => {
    if (!profileOpen || !options.wallet.allowance || walletControlBusy(busy, win, command.action)) throw new Error("WALLET_BUSY");
    busy.set(win, command.action);
    try {
      if (command.action === "allowance_confirm" || command.action === "allowance_resend") {
        const text = await messages();
        assertCurrent(win, generation);
        let detail: string;
        if (command.action === "allowance_confirm") {
          const original = preview;
          preview = undefined;
          if (original?.win !== win || original.generation !== generation || original.walletId !== command.walletId ||
            original.id !== command.previewId) throw new Error("ALLOWANCE_PREVIEW_EXPIRED");
          detail = original.detail;
        } else {
          detail = text.allowanceResend + "\n" + command.hash;
        }
        const answer = await dialog.showMessageBox(win, { type: "question", title: text.allowanceTitle!, message: text.allowanceAuth!,
          detail, buttons: [text.cancel!, text.confirm!], cancelId: 0, defaultId: 0 });
        if (answer.response !== 1) throw new Error("WALLET_INTERACTION_CANCELED");
        assertCurrent(win, generation);
        await options.authenticate(text.allowanceAuth!);
      }
      assertCurrent(win, generation);
      const value = await options.wallet.allowance(command);
      assertCurrent(win, generation);
      if (command.action === "allowance_preview") {
        const q = value as { id: string; network: string; address: string; spender: string; amount: string; feeWei: string };
        const text = await messages();
        assertCurrent(win, generation);
        preview = { win, generation, walletId: command.walletId, id: q.id,
          detail: [q.network === "eip155:8453" ? "Base Mainnet" : "Base Sepolia", q.address, "Permit2 · " + q.spender,
            text.allowanceTarget + " · " + display(q.amount, 6) + " USDC", text.allowanceEstimate + " · " + display(q.feeWei, 18) + " ETH"].join("\n") };
      }
      return { ok: true, value };
    } finally { busy.delete(win); }
  };
}
