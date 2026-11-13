import { dialog, type BrowserWindow } from "electron";
import { realpath } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { DesktopWalletInteraction } from "./desktopWalletInteraction.js";
import type { DesktopWalletWindowOptions } from "./desktopWalletWindowPolicy.js";

export interface WalletResponseDestination {
  directory: string;
  name: string;
  responsePath: string;
  outputBasePath: string;
}
type Options = {
  host: DesktopWalletWindowOptions;
  current(): BrowserWindow | undefined;
  epoch(): number;
  assertCurrent(window: BrowserWindow, generation: number): void;
  show(): Promise<void>;
  retire(window: BrowserWindow): void;
  messages(): Promise<Record<string, string>>;
  busy: Map<BrowserWindow, string>;
  observations: Map<BrowserWindow, DesktopWalletInteraction>;
};

/** Native user selection only. No renderer or model may supply a filesystem path. */
export function createWalletResponseDestinationPicker(options: Options) {
  return async (
    requestId: string,
    signal: AbortSignal,
  ): Promise<WalletResponseDestination | undefined> => {
    if (!/^[0-9a-f-]{36}$/.test(requestId)) throw new Error("WALLET_INVALID_RESPONSE");
    signal.throwIfAborted();
    await options.show();
    const win = options.current(),
      generation = options.epoch();
    if (!win || options.busy.size) throw new Error("WALLET_BUSY");
    const assertCurrent = () => {
      options.assertCurrent(win, generation);
      signal.throwIfAborted();
    };
    assertCurrent();
    options.busy.set(win, "response_destination");
    const observation = new DesktopWalletInteraction(
      () => {
        try {
          assertCurrent();
          return true;
        } catch {
          return false;
        }
      },
      () => options.retire(win),
    );
    options.observations.set(win, observation);
    const abort = () => observation.cancel();
    signal.addEventListener("abort", abort, { once: true });
    let release: (() => void) | undefined;
    const releaseSensitive = () => {
      const lease = release;
      release = undefined;
      lease?.();
    };
    const work = (async () => {
      release = await options.host.enterSensitiveUi();
      assertCurrent();
      const text = await options.messages();
      for (const key of ["responseSaveTitle", "responseSaveMessage", "responseSaveButton"])
        if (!text[key] || text[key]!.length > 2048) throw new Error("WALLET_UNAVAILABLE");
      assertCurrent();
      const result = await dialog.showSaveDialog(win, {
        title: text.responseSaveTitle,
        message: `${text.responseSaveMessage}\n${requestId}`,
        buttonLabel: text.responseSaveButton,
        defaultPath: `koincode-${requestId}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
        properties: ["createDirectory", "showOverwriteConfirmation", "dontAddToRecent"],
      });
      assertCurrent();
      if (result.canceled || !result.filePath) return undefined;
      const name = basename(result.filePath);
      if (extname(name).toLowerCase() !== ".json" || name.length > 200)
        throw new Error("DESTINATION_INVALID");
      const directory = await realpath(dirname(result.filePath));
      assertCurrent();
      return {
        directory,
        name,
        responsePath: join(directory, name),
        outputBasePath: join(directory, name.slice(0, -5)),
      };
    })();
    try {
      return await Promise.race([work, observation.canceled]);
    } finally {
      observation.stop();
      signal.removeEventListener("abort", abort);
      if (options.observations.get(win) === observation) options.observations.delete(win);
      options.busy.delete(win);
      releaseSensitive();
      // The sensitive gate can finish entering after cancellation; do not leak that late lease.
      void work.finally(releaseSensitive).catch(() => {});
    }
  };
}
