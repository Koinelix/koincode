import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { protectedJson } from "../app/commitments.js";
import type { ProtectedStore } from "../app/ports.js";
import type { RequestEnvironment } from "../app/requestPorts.js";
import type { WalletRuntime } from "../app/runtime.js";
import { requireWallet } from "../domain/errors.js";
import { PinnedHttp } from "./controlledHttp.js";
import type { LocalWalletOptions } from "./localService.js";
import type { ProtectedProfile } from "./profileRecords.js";
import { EncryptedRequestBlobs } from "./requestBlobs.js";
import { requestDelay } from "./requestDelay.js";
import { SdkPaymentBuilder } from "./sdkPayment.js";
import { inspectResponse } from "./responseInspection.js";

export interface LocalWalletRequestOptions {
  namespace?: LocalWalletOptions["namespace"];
  generalAllowance?: LocalWalletOptions["generalAllowance"];
  generalPayment?: LocalWalletOptions["generalPayment"];
  keychainHelper: string;
  mode?: LocalWalletOptions["mode"];
  localBaseSepoliaTest?: boolean;
  authorize: RequestEnvironment["authorize"];
  checkOutbound: RequestEnvironment["checkOutbound"];
}

/** Capture trusted configuration before any asynchronous initialization. */
export function requestBootstrapConfiguration(options: LocalWalletRequestOptions) {
  const suppliedMode = options.mode;
  const mode = suppliedMode === undefined ? "open" : suppliedMode;
  const authorize = options.authorize;
  const checkOutbound = options.checkOutbound;
  const localBaseSepoliaTest = options.localBaseSepoliaTest === true;
  const namespace = options.namespace;
  requireWallet(
    (mode === "open" || mode === "create" || mode === "resume_setup" || mode === "import_setup") &&
      typeof authorize === "function" &&
      typeof checkOutbound === "function" && (namespace === undefined || namespace === "m4-testnet" || namespace === "mainnet"),
    "INVALID_REQUEST_CONFIGURATION",
    "The trusted wallet request configuration is invalid.",
  );
  requireWallet(!localBaseSepoliaTest || namespace !== "mainnet", "INVALID_REQUEST_CONFIGURATION", "Mainnet cannot use the local test transport.");
  return { mode, authorize, checkOutbound, localBaseSepoliaTest, namespace };
}

/** Internal adapter: open once, then enable requests on the lease-owning runtime. */
export async function bootstrapWalletRequests(
  options: LocalWalletRequestOptions,
  protection: ProtectedStore,
  open: (mode: LocalWalletOptions["mode"]) => Promise<WalletRuntime>,
) {
  const { mode, authorize, checkOutbound, localBaseSepoliaTest } =
    requestBootstrapConfiguration(options);
  const cleanup = protection as ProtectedStore & { removeResponseSecret?: unknown; removeResponseFile?: unknown };
  requireWallet(typeof cleanup.removeResponseSecret === "function" && typeof cleanup.removeResponseFile === "function",
    "INVALID_REQUEST_CONFIGURATION", "Local response retention requires protected key and file cleanup.");
  const runtime = await open(mode);
  try {
    // Read the profile only after open has acquired the service lease.
    const profile = await protectedJson<ProtectedProfile>(protection, "wallet-profile");
    requireWallet(
      profile?.phase === "READY",
      "WALLET_RECOVERY_REQUIRED",
      "An initialized healthy wallet profile is required.",
    );
    const blobs = await EncryptedRequestBlobs.open(
      join(profile.directory, "http-blobs"),
      protection,
    );
    const requests = await runtime.enableRequests(
      {
        blobs,
        retainedBlobs: blobs,
        http: localBaseSepoliaTest
          ? PinnedHttp.baseSepoliaLocalTest()
          : PinnedHttp.publicInternet(),
        authorize,
        checkOutbound,
        inspectResponse,
        delay: requestDelay,
        wall: Date.now,
        monotonic: () => performance.now(),
      },
      protection,
      new SdkPaymentBuilder(runtime.payments),
    );
    return { runtime, requests, directory: profile.directory };
  } catch (error) {
    // close() releases the runtime and its profile lease; it does not remove the
    // profile, protected material, blobs or operation history.
    await runtime.close();
    throw error;
  }
}
