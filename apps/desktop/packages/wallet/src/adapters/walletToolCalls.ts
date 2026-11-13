import type { WalletRuntime } from "../app/runtime.js";
import type { WalletRequests } from "../app/requests.js";
import type { ClientHandle } from "../app/sessions.js";
import { requireWallet, WalletError } from "../domain/errors.js";
import { HTTP_STAGE_TIMEOUT_MS, REQUEST_ACTION_TIMEOUT_MS } from "../domain/requestTiming.js";
import { RESPONSE_LIMIT, RESPONSE_WIRE_LIMIT } from "../domain/requestValidation.js";
import { ResponseExporter } from "./responseExport.js";
import { record, keys } from "./hostRequestProtocol.js";

/** Authenticated non-request tools shared by MCP and the private host data channel. */
export class WalletToolCalls {
  constructor(
    private readonly runtime: WalletRuntime,
    private readonly requests: WalletRequests,
    private readonly handle: ClientHandle,
    private readonly exporter = new ResponseExporter(requests),
  ) {}

  async call(name: string, raw: unknown, signal?: AbortSignal): Promise<unknown> {
    this.runtime.sessions.resolve(this.handle);
    signal?.throwIfAborted();
    requireWallet(record(raw), "INVALID_REQUEST", "A wallet tool requires an argument object.");
    const input = structuredClone(raw);
    this.runtime.sessions.resolve(this.handle);
    signal?.throwIfAborted();
    if (name === "wallet_get_capabilities") {
      requireWallet(keys(input, []), "INVALID_REQUEST", "Capabilities accept no arguments.");
      return {
        protocolVersion: 2,
        httpStageTimeoutMs: HTTP_STAGE_TIMEOUT_MS,
        requestTimeoutMs: REQUEST_ACTION_TIMEOUT_MS,
        schemes: ["exact"],
        networks: [this.runtime.paymentNetwork],
        transferMethods: ["eip3009"],
        requestMethods: ["GET", "POST"],
        authentication: "registered_client_token",
        identityLevel: "token_only",
        operationMetadata: "io.koinelix.wallet/operationId",
        response: {
          read: "sdk",
          export: "x402_export_response",
          retentionSeconds: 604800,
          recover: "x402_recover_response",
          rawRetentionSeconds: 86400,
          maxDecodedBytes: RESPONSE_LIMIT,
          maxWireBytes: RESPONSE_WIRE_LIMIT,
        },
        mainnet: false,
        approvedDestinations: this.exporter.list(this.handle),
        credentialReferences: this.requests.credentials.list(this.handle),
      };
    }
    if (name === "wallet_get_info") {
      requireWallet(keys(input, []), "INVALID_REQUEST", "Wallet information accepts no arguments.");
      return this.runtime.list().flatMap((wallet) => {
        try {
          return [this.runtime.query(this.handle, wallet.walletId)];
        } catch {
          return [];
        }
      });
    }
    if (name === "x402_lookup_operation") {
      requireWallet(
        keys(input, ["operationId"]) &&
          typeof input.operationId === "string" &&
          input.operationId.length <= 150,
        "INVALID_REQUEST",
        "An operation UUID is required.",
      );
      return this.requests.lookupOperation(this.handle, input.operationId);
    }
    const id = input.requestId;
    const supported = [
      "x402_get_request",
      "x402_reconcile",
      "x402_recover_response",
      "x402_cancel_request",
      "x402_export_response",
    ];
    requireWallet(supported.includes(name), "TOOL_NOT_FOUND", "The wallet tool is unavailable.");
    requireWallet(
      typeof id === "string" && id.length <= 100,
      "INVALID_REQUEST",
      "A request ID is required.",
    );
    if (name === "x402_get_request") {
      requireWallet(
        (keys(input, ["requestId"]) || keys(input, ["requestId", "waitMs"])) &&
          (input.waitMs === undefined ||
            (Number.isInteger(input.waitMs) &&
              (input.waitMs as number) >= 0 &&
              (input.waitMs as number) <= 5000)),
        "INVALID_REQUEST",
        "Request lookup accepts only its ID and bounded wait interval.",
      );
      return this.requests.get(this.handle, id);
    }
    if (name === "x402_export_response") {
      requireWallet(
        keys(input, ["requestId", "destinationRef"]) &&
          typeof input.destinationRef === "string" &&
          input.destinationRef.length <= 150,
        "DESTINATION_NOT_FOUND",
        "An approved output reference is required.",
      );
      return await this.exporter.export(this.handle, id, input.destinationRef, signal);
    }
    if (name === "x402_reconcile") {
      requireWallet(keys(input, ["requestId"]) || keys(input, ["requestId", "transactionHash"]),
        "INVALID_REQUEST", "Reconciliation accepts its original request ID and an optional transaction lookup hint.");
      requireWallet(!Object.hasOwn(input, "transactionHash") || (typeof input.transactionHash === "string" && /^0x[0-9a-f]{64}$/i.test(input.transactionHash)),
        "INVALID_REQUEST", "A transaction lookup hint must be a 32-byte hash.");
      return await this.requests.reconcile(this.handle, id, signal, input.transactionHash as string | undefined);
    }
    requireWallet(
      keys(input, ["requestId"]),
      "INVALID_REQUEST",
      "This tool accepts only the original request ID.",
    );
    if (name === "x402_recover_response")
      return await this.requests.recoverRetainedResponse(this.handle, id, signal);
    if (name === "x402_cancel_request") return await this.requests.cancel(this.handle, id);
    throw new WalletError("TOOL_NOT_FOUND", "The wallet tool is unavailable.");
  }
}
