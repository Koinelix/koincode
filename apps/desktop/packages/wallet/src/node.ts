export { WalletDatabase } from "./adapters/database.js";
export {
  openLocalWallet,
  walletServiceDirectory,
  type LocalWalletOptions,
  recoverLocalWallet,
  relocateLocalWallet,
  type LocalRecoveryOptions,
} from "./adapters/localService.js";
export type {
  WalletInfo,
  WalletDisplayInfo,
  WalletQuery,
  GrantInput,
  LimitInput,
  ManagementCommand,
  ManagementResult,
  WalletInspection,
  WalletInspectionSection,
} from "./app/runtimeTypes.js";
export { openLocalWalletRequests } from "./adapters/localRequests.js";
export { startWalletSocket } from "./adapters/socketMcp.js";
export { createAuthenticatedPaymentClient } from "./adapters/paymentClient.js";
export { runWalletStdioBridge } from "./adapters/stdioBridge.js";
export { connectWalletMcp, walletMcpTools } from "./adapters/mcpServer.js";
export { ResponseExporter } from "./adapters/responseExport.js";
export type { WalletRequests } from "./app/requests.js";
export type {
  PaymentApprovalView,
  PaymentApprovalChoice,
  PaymentApprovalDecision,
} from "./app/paymentApprovalTypes.js";
export type {
  ResponseReservation,
  OutboundAuthorizationContext,
  OutboundEffect,
  HttpContextCheck,
  HttpContextStage,
  ControlledHttp,
  HttpResult,
} from "./app/requestPorts.js";
export type { X402RequestInput, RequestView, HostPaymentInput, HostPaymentPrepared, HostPaymentMaterial, FrozenRequest } from "./domain/requestModel.js";
export { PinnedHttp, targetUrl, publicAddress } from "./adapters/controlledHttp.js";
export { inspectResponse } from "./adapters/responseInspection.js";
export { validateInput, jsonBody, headerName, REQUEST_LIMIT, RESPONSE_LIMIT, RESPONSE_WIRE_LIMIT } from "./domain/requestValidation.js";
export { DurableOperationAdapter } from "./adapters/durableOperations.js";
export { createWalletClient, type WalletClientPort } from "./adapters/walletClient.js";

export type { JournalCheckpoint, JournalCommitter } from "./domain/operationJournal.js";
export {
  createHostWalletRequestBridge,
  type HostWalletRequestBridge,
  type HostWalletRequestBridgeOptions,
  type HostWalletInvocation,
} from "./adapters/hostRequestBridge.js";
export { createHostWalletChannelClient } from "./adapters/hostRequestClient.js";
export { serveHostWalletRequests } from "./adapters/hostRequestServer.js";
export type { HostRequestClient, HostRequestMessagePort } from "./adapters/hostRequestProtocol.js";
export {
  HostWalletConnections,
  type HostWalletConnection,
  type HostPaymentPresenter,
} from "./adapters/hostConnections.js";
