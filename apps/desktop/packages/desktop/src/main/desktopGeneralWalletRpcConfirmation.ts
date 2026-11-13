import { BrowserWindow, dialog } from "electron";
import en from "../renderer/public/wallet/en-US.json" with { type: "json" };
import zh from "../renderer/public/wallet/zh-CN.json" with { type: "json" };

/** Text and destination are owned by Main; the renderer cannot approve its own selection. */
export async function confirmGeneralRpc(window: BrowserWindow, locale: string, networkId: string,
  candidate: { provider: string; endpoint: string }, signal: AbortSignal): Promise<boolean> {
  const text = locale === "zh-CN" ? zh : en;
  if (signal.aborted || window.isDestroyed() || !window.isVisible() || window.isMinimized()) return false;
  const contents = window.webContents;
  const cancellation = new AbortController(), cancel = () => cancellation.abort();
  signal.addEventListener("abort", cancel, { once: true });
  window.once("closed", cancel); window.once("hide", cancel); window.once("minimize", cancel);
  contents.once("destroyed", cancel);
  let confirmation: BrowserWindow | undefined;
  try {
    if (signal.aborted) return false;
    confirmation = new BrowserWindow({ width: 460, height: 200, title: text.generalRpcConfirmTitle,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    confirmation.once("closed", cancel);
    confirmation.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    confirmation.webContents.on("will-navigate", (event) => event.preventDefault());
    const result = await dialog.showMessageBox(confirmation, {
      type: "question", title: text.generalRpcConfirmTitle, message: text.generalRpcConfirmMessage,
      detail: `${text.generalRpcConfirmNetwork}: ${networkId}\n${text.generalRpcConfirmProvider}: ${candidate.provider}\n` +
        `${text.generalRpcConfirmEndpoint}: ${candidate.endpoint}\n\n${text.generalRpcConfirmDetail}`,
      buttons: [text.cancel, text.confirm], defaultId: 0, cancelId: 0, noLink: true, signal: cancellation.signal,
    });
    return result.response === 1 && !cancellation.signal.aborted && !signal.aborted &&
      !window.isDestroyed() && window.isVisible() && !window.isMinimized();
  } catch { return false; }
  finally {
    signal.removeEventListener("abort", cancel);
    window.removeListener("closed", cancel); window.removeListener("hide", cancel); window.removeListener("minimize", cancel);
    contents.removeListener("destroyed", cancel);
    if (confirmation && !confirmation.isDestroyed()) confirmation.destroy();
  }
}
