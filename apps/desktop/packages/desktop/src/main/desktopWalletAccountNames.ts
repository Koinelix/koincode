import { ipcMain, type BrowserWindow } from "electron";
import { readWalletAccountNames, renameWalletAccount } from "../general-wallet/accountNames.js";
import { isTrustedWalletSender } from "./desktopWalletWindowPolicy.js";
const CHANNEL = "koincode:wallet-account-names";
export function attachWalletAccountNames(options: {
  expectedUrl: string; current(): BrowserWindow | undefined; epoch(): number;
  assertCurrent(window: BrowserWindow, epoch: number): void;
  wallets(): Promise<Array<{ address: string }>>;
}): () => void {
  let inFlight = false;
  ipcMain.handle(CHANNEL, async (event, raw: unknown) => {
    let admitted = false;
    try {
      const win = options.current(), generation = options.epoch();
      if (!win || !isTrustedWalletSender({ sender: event.sender, expectedSender: win.webContents, frame: event.senderFrame, mainFrame: win.webContents.mainFrame, frameUrl: event.senderFrame?.url, expectedUrl: options.expectedUrl, visible: win.isVisible() && !win.isMinimized() }))
        throw new Error("WALLET_UNTRUSTED_SOURCE");
      const current = () => options.assertCurrent(win, generation); current();
      if (inFlight) throw new Error("WALLET_BUSY");
      inFlight = true; admitted = true;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_REQUEST");
      const command = raw as { action: string; address?: string; name?: unknown };
      if (command.action === "read" && Object.keys(command).join() === "action") {
        const names = await readWalletAccountNames(); current(); return { ok: true, value: names };
      }
      if (command.action !== "rename" || Object.keys(command).sort().join() !== "action,address,name" || typeof command.address !== "string")
        throw new Error("INVALID_REQUEST");
      const wallets = await options.wallets(); current();
      const address = command.address.toLowerCase();
      if (!wallets.some(wallet => wallet.address.toLowerCase() === address)) throw new Error("WALLET_NOT_FOUND");
      await renameWalletAccount(address, command.name, current); current(); return { ok: true, value: null };
    } catch { return { ok: false, error: "WALLET_NAME_UPDATE_FAILED" }; }
    finally { if (admitted) inFlight = false; }
  });
  return () => ipcMain.removeHandler(CHANNEL);
}
