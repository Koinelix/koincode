import { walletWindowError, type DesktopWalletWindowOptions } from "./desktopWalletWindowPolicy.js";

/** A first-run installation owns no wallet profile yet; this is guided setup, never an error. */
export const WALLET_PROFILE_ABSENT = "WALLET_PROFILE_ABSENT";

/** Display startup opens only; creating, unlocking and payment remain explicit operations. */
export async function openWalletForDisplay(wallet: Pick<DesktopWalletWindowOptions["wallet"], "start"> & { openExisting?: () => Promise<void> }): Promise<{
  profileOpen: boolean;
  setupRequired?: true;
  startupError?: string;
}> {
  try {
    if (wallet.openExisting) await wallet.openExisting(); else await wallet.start("open");
    return { profileOpen: true };
  } catch (error) {
    const code = walletWindowError(error);
    if (code === WALLET_PROFILE_ABSENT) return { profileOpen: false, setupRequired: true };
    return { profileOpen: false, startupError: code };
  }
}
