import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { WalletRuntime } from "../app/runtime.js";
import type { WalletRequests } from "../app/requests.js";
import type { ClientHandle } from "../app/sessions.js";
import { requireWallet, WalletError } from "../domain/errors.js";
import { ResponseExporter } from "./responseExport.js";
import { walletMcpTools } from "./hostTools.js";
import { WalletToolCalls } from "./walletToolCalls.js";
export { walletMcpTools } from "./hostTools.js";
export async function connectWalletMcp(
  runtime: WalletRuntime,
  requests: WalletRequests,
  handle: ClientHandle,
  transport: Transport,
  exporter = new ResponseExporter(requests),
): Promise<Server> {
  const server = new Server(
    { name: "koin-wallet", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const tools = new WalletToolCalls(runtime, requests, handle, exporter);
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    runtime.sessions.resolve(handle);
    return { tools: structuredClone(walletMcpTools) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
    try {
      runtime.sessions.resolve(handle);
      const input = call.params.arguments ?? {},
        name = call.params.name;
      let result: unknown;
      if (name === "x402_request") {
        const operationId = call.params._meta?.["io.koinelix.wallet/operationId"];
        requireWallet(
          typeof operationId === "string",
          "OPERATION_CONTEXT_REQUIRED",
          "The registered adapter must attach its durable operation UUID.",
        );
        result = await requests.request(handle, input, operationId, extra.signal);
      } else result = await tools.call(name, input, extra.signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              code: error instanceof WalletError ? error.code : "WALLET_REQUEST_FAILED",
              message: "The wallet operation could not be completed. No new retry is authorized.",
            }),
          },
        ],
      };
    }
  });
  server.onclose = () => {
    void runtime.sessions.disconnect(handle).catch(() => {});
  };
  await server.connect(transport);
  return server;
}
