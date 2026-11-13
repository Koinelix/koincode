/** Thin host integration: no runtime, custody, storage or Electron dependencies. */
export { createHostWalletRequestBridge } from "./adapters/hostRequestBridge.js";
export type { HostWalletInvocation, HostWalletRequestBridge, HostWalletRequestBridgeOptions } from "./adapters/hostRequestBridge.js";
export { walletMcpTools } from "./adapters/hostTools.js";
export { createHostWalletChannelClient } from "./adapters/hostRequestClient.js";
export type { HostRequestClient, HostRequestMessagePort } from "./adapters/hostRequestProtocol.js";
export type { RequestView, X402RequestInput, HostPaymentInput, HostPaymentPrepared, HostPaymentMaterial } from "./domain/requestModel.js";
export type { createAuthenticatedPaymentClient } from "./adapters/paymentClient.js";
