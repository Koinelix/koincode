import { app, systemPreferences } from "electron";

export interface WalletApplicationVisibility {
  hidden(): boolean;
  dispose(): void;
}

/** Native application hide is separate from BrowserWindow visibility on macOS. */
export function observeWalletApplicationHide(onHide: () => void): WalletApplicationVisibility {
  if (process.platform !== "darwin") return { hidden: () => false, dispose() {} };
  let disposed = false;
  const subscription = systemPreferences.subscribeLocalNotification(
    "NSApplicationWillHideNotification",
    () => {
      if (disposed) return;
      try {
        onHide();
      } catch {
        // The owner retires its UI even when the lock request fails.
      }
    },
  );
  return {
    hidden: () => {
      if (disposed) throw new Error("WALLET_WINDOW_DISPOSED");
      return app.isHidden();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      systemPreferences.unsubscribeLocalNotification(subscription);
    },
  };
}
