import type { WalletHostAgent } from "@fcode/shared";
import type { Channel, WalletHostScope } from "./desktopWalletHostTypes.js";
import { failure } from "./desktopWalletHostIdentity.js";

type Agent = WalletHostAgent & { ended: boolean; ready?: Promise<void> };

/** The caller authenticates the host's session route before this read-only lookup. */
export async function lookupWalletActivity(scope: WalletHostScope, workspaceKey: string, sessionId: string,
  paymentId: string, access: {
    currentHost(scope: WalletHostScope): boolean;
    currentAgent(): Agent | undefined;
    connect(agent: Agent, signal: AbortSignal): Promise<{ client: Channel; isCurrent(): boolean }>;
  }, refresh = false): Promise<unknown> {
  if (!access.currentHost(scope) || !workspaceKey || workspaceKey.length > 8192 || !sessionId || sessionId.length > 256 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(paymentId))
    throw failure("CLIENT_AUTHENTICATION_REQUIRED");
  const agent = access.currentAgent(), signal = AbortSignal.timeout(10_000);
  if (!agent || agent.ended) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
  await agent.ready;
  if (access.currentAgent() !== agent || agent.ended || signal.aborted) throw failure("CLIENT_AUTHENTICATION_REQUIRED");
  const connection = await access.connect(agent, signal);
  const check = () => {
    if (!access.currentHost(scope) || access.currentAgent() !== agent || agent.ended || signal.aborted || !connection.isCurrent())
      throw failure("CLIENT_AUTHENTICATION_REQUIRED");
  };
  check();
  const result = await connection.client.callPaymentClient("read_activity", { paymentId, workspaceKey, sessionId, ...(refresh ? { refresh: true } : {}) }, signal);
  check();
  return result;
}
