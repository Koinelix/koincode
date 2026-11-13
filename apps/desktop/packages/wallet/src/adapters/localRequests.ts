import { createLocalKeychainStore } from "./userKeychain.js";
import { openLocalWallet } from "./localService.js";
import {
  bootstrapWalletRequests,
  requestBootstrapConfiguration,
  type LocalWalletRequestOptions,
} from "./requestBootstrap.js";

/** Trusted host entrypoint. The mode and outbound authorization never come from model input. */
export async function openLocalWalletRequests(options: LocalWalletRequestOptions) {
  const configuration = requestBootstrapConfiguration(options);
  const keychainHelper = options.keychainHelper;
  const protection = createLocalKeychainStore(keychainHelper);
  return bootstrapWalletRequests({ ...configuration, keychainHelper }, protection, (mode) =>
    openLocalWallet({ mode, keychainHelper, namespace: configuration.namespace, generalAllowance: options.generalAllowance, generalPayment: options.generalPayment }),
  );
}
