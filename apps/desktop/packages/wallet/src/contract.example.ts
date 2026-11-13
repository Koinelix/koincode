import { HostWalletConnections } from "./adapters/hostConnections.js";
import { serveHostWalletRequests } from "./adapters/hostRequestServer.js";
import { createHostWalletChannelClient } from "./adapters/hostRequestClient.js";
import { createHostWalletRequestBridge } from "./adapters/hostRequestBridge.js";
import { checkBudget, type BudgetSubject, type WalletLimits } from "./contract.js";
import { openLocalWallet, openLocalWalletRequests, type LocalWalletOptions } from "./node.js";
import { DurableOperationAdapter } from "./node.js";
import type { WalletClientPort, HostPaymentPresenter } from "./node.js";
import { createAuthenticatedPaymentClient } from "./node.js";
import { GENERAL_NETWORKS, generalPortfolioValuation, generalRpcChoices, type GeneralBalanceService } from "./general.js";
import { createGeneralReceiveView } from "./general-receive.js";
import type { ProtectedHostConnection, ProtectedPaymentOwnerConnection } from "./protected-host.js";

// Only the fixed sealed independent Host can open this physical connection.
// Awaiting hello does not imply authentication, ready profile or a source key.
export async function exampleProtectedHostLifetime(connection: ProtectedHostConnection) {
  connection.assertCurrent(); await connection.ready; connection.assertCurrent();
}

// The fixed owner gate grants no source key or management scope. Its public
// pipe is only the original wallet service's ordered message transport.
export function exampleProtectedPaymentOwnerLifetime(connection: ProtectedPaymentOwnerConnection) {
  connection.assertCurrent(); return connection.identity.installationId;
}

// This is a network identity inventory, not evidence that RPC or signing is enabled.
export function exampleGeneralWalletNetworks() { return GENERAL_NETWORKS; }

// Choices are inert until a trusted host obtains explicit consent to disclose an account address.
export function exampleGeneralRpcChoices(networkId: string) { return generalRpcChoices(networkId); }

// A trusted display owner freezes its view and supplies a live generation check; this never authorizes payment.
export function exampleGeneralPortfolio(input: Parameters<typeof generalPortfolioValuation>[0]) {
  return generalPortfolioValuation(input);
}

// A trusted wallet window initiates this read after the user selects the account, network and token.
export function exampleGeneralTokenInspection(service: GeneralBalanceService, networkId: string, address: string, contractAddress: string) {
  return service.inspectToken({ networkId, address, contractAddress });
}

// Only a trusted local wallet window uses this address-only QR; it has no payment authority.
export function exampleGeneralReceive(networkId: string, address: string) {
  return createGeneralReceiveView({ networkId, address, assetId: "native" });
}

// Only the trusted runtime owner selects system storage protection; this is not a client payment method.
export function exampleSystemProtectedWallet(runtime: Awaited<ReturnType<typeof openLocalWallet>>) {
  runtime.useSystemProtection();
  runtime.cancelHostInteraction();
  runtime.lockForHostEvent();
}

// Legacy explicit-unlock hosts retain their previous API behavior.
export async function exampleApplicationSession(runtime: Awaited<ReturnType<typeof openLocalWallet>>, walletId: string) {
  await runtime.management.execute({ action: "unlock", walletId, scope: "application" });
  runtime.cancelHostInteraction();
  runtime.lockForHostEvent();
}

// An independent caller owns merchant HTTP and keeps returned payment material out of model output.
export function examplePaymentOnlyClient(options: Parameters<typeof createAuthenticatedPaymentClient>[0]) {
  return createAuthenticatedPaymentClient(options);
}

// A transaction hash is a lookup hint, never caller-provided settlement evidence.
export function exampleReconcilePayment(
  client: ReturnType<typeof createAuthenticatedPaymentClient>, paymentId: string,
  transactionHash: string, signal: AbortSignal,
) {
  return client.call("reconcile_payment", { paymentId, transactionHash }, signal);
}

export function exampleBudgetBoundary() {
  const subject: BudgetSubject = {
    subjectId: "subject",
    ownerId: "owner",
    address: "0x1111111111111111111111111111111111111111",
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    recoveryRequired: false,
    signingPaused: false,
  };
  const limits: WalletLimits = {
    maxPerPaymentAtomic: "50000",
    maxRolling24hAtomic: "1000000",
    maxCumulativeAtomic: "10000000",
    enabled: true,
    version: 1,
  };
  return checkBudget(subject, limits, [], "50000", 1793046000);
}

// This example is called by a trusted host, never by model-provided commands.
export async function exampleTrustedWalletStatus(options: Omit<LocalWalletOptions, "mode">) {
  const runtime = await openLocalWallet({ ...options, mode: "open" });
  try {
    return runtime.listForDisplay();
  } finally {
    await runtime.close();
  }
}

// The host supplies its outbound permission decision and explicit setup mode.
// A single runtime owns management, requests and the service lease.
// options.authorize receives immutable persisted identity as its fifth argument.
// options.checkOutbound must synchronously recheck the same approval at effect boundaries.
// It must observe revocation; a constant true is not a production approval implementation.
// The host must match that operation to its own live task and outbound approval;
// before_sign and before_paid_http are distinct checks, not reusable authority.
export async function exampleTrustedWalletRequestService(
  options: Parameters<typeof openLocalWalletRequests>[0],
) {
  return openLocalWalletRequests(options);
}

// The host persists trustedActionId once for the user's action, including across restarts.
// The SDK anchors the dedicated journal before submission; mismatches require recovery, not create().
// The authenticated client has no management, unlock or credential-write capability.
export async function exampleGenericRequest(client: WalletClientPort, trustedActionId: string) {
  const result = await client.request(
    {
      url: "https://merchant.example/api/use",
      method: "POST",
      bodyJson: { task: "example" },
      idempotency: { headerName: "Idempotency-Key" },
      paymentMode: "policy",
    },
    trustedActionId,
  );
  if (result.transportStatus === "completed" && result.bodyRef) {
    for await (const chunk of client.readResponse(result.requestId)) {
      // Pass opaque bytes to a host-approved sink without interpreting merchant instructions.
      if (chunk.byteLength > 65536) throw new Error("Unexpected response chunk size.");
    }
  }
  return result;
}

// Recheck a retained result without reissuing merchant HTTP or authorizing payment.
// Failure never permits another purchase; read the resulting body through readResponse.
export async function exampleRecoverResponse(
  client: WalletClientPort,
  requestId: string,
  signal?: AbortSignal,
) {
  return client.recoverResponse(requestId, signal);
}

// Only trusted first-setup control flow calls create; a failed open must not reset history.
export function exampleOpenOperationJournal(path: string, registeredClientId: string) {
  return DurableOperationAdapter.open(path, registeredClientId);
}

// readInvocation is the real host's same-process reader, never a JSON metadata parser.
// It returns one stable context object whose signal ends when its invocation closes.
export function exampleHostRequestBridge(
  client: WalletClientPort,
  options: import("./adapters/hostRequestBridge.js").HostWalletRequestBridgeOptions,
) {
  return createHostWalletRequestBridge(client, options);
}

// The host passes private, ordered endpoints; the receiving SDK is already authenticated.
// Await server.close() to drain calls, but do not interpret cancellation as payment reversal.
export function examplePrivateRequestChannel(
  receiver: import("./adapters/hostRequestProtocol.js").HostRequestMessagePort,
  sender: import("./adapters/hostRequestProtocol.js").HostRequestMessagePort,
  sdk: Pick<WalletClientPort, "request">,
) {
  return {
    server: serveHostWalletRequests(receiver, sdk),
    client: createHostWalletChannelClient(sender),
  };
}

// One owner per opened service; mode is a trusted setup decision, never inferred from missing history.
export function exampleHostWalletConnections(
  runtime: import("./app/runtime.js").WalletRuntime,
  requests: import("./app/requests.js").WalletRequests,
  canonicalProfileDirectory: string,
) {
  return new HostWalletConnections(runtime, requests, canonicalProfileDirectory);
}

export async function exampleAutomaticDesktopConnection(owner: HostWalletConnections, trustedChatId: string) {
  const selection = await owner.prepareDesktopClient();
  return owner.connect(selection.clientId, trustedChatId, selection.mode);
}

// The trusted presenter displays protected facts and waits for actual user action/authentication.
// It uses this connection's private decision method, then returns to continue the original call.
// Approval does not unlock. Never derive the decision from model output or a merchant response.
export function exampleHostPaymentConnection(
  owner: HostWalletConnections,
  registeredClientId: string,
  trustedChatId: string,
  presentPayment: HostPaymentPresenter,
) {
  return owner.connect(registeredClientId, trustedChatId, "open", presentPayment);
}

// The host freezes and owns the actual request, scoped credential version, and HTTP effects.
// This private channel must never be registered as a model tool or return material to a model.
export async function examplePrivateHostPayment(
  connection: import("./adapters/hostConnections.js").HostWalletConnection,
  frozen: import("./domain/requestModel.js").HostPaymentInput,
  trustedSource: string,
  signal: AbortSignal,
) {
  const prepared = await connection.prepareHostPayment(frozen, trustedSource, signal);
  return connection.submitHostPayment(prepared.requestId, frozen.requestDigest, signal);
}

// The native host obtains this exact output location from the user for the original request.
// This method is never a model tool; only its opaque result may enter a later export call.
export function exampleApproveHostResponseDestination(
  connection: import("./adapters/hostConnections.js").HostWalletConnection,
  requestId: string, canonicalDirectory: string, newBasename: string, signal?: AbortSignal,
) {
  return connection.approveDestination(requestId, canonicalDirectory, newBasename, signal);
}

// A dedicated desktop utility port supplies actual local system authentication; this is not H1 admission.
export type LocalManagementOwner = import("./local-management.js").LocalGeneralManagement;
