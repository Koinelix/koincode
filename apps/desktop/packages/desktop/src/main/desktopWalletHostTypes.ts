import type { createHostWalletChannelClient } from "@koincode/wallet/host";
import type { WalletHostAgent, WalletHostCall, WalletHostMainResult } from "@fcode/shared";

export interface WalletHostScope { windowId: string; hostId: string }
export type Channel = ReturnType<typeof createHostWalletChannelClient>;
export type Binding = { clientId: string; mode: "create" | "open"; automatic?: boolean; initialized?: Promise<void>; failed?: boolean };
export type Connection = { processEnded?: boolean; id: string; hostId: string; agent: WalletHostAgent;
  closed: boolean; ready: Promise<Channel>; client?: Channel; closing?: Promise<void> };
export type Job = { statusProbe: boolean; uncertain?: boolean; hostId: string; agent: WalletHostAgent;
  controller: AbortController; done: Promise<WalletHostMainResult> };
export interface DesktopServiceRequestContext {
  scope: WalletHostScope;
  agent: WalletHostAgent;
  input: WalletHostCall;
  signal: AbortSignal;
  isCurrent(): boolean;
  connectWallet(): Promise<{ client: Channel; clientId: string; isCurrent(): boolean; drainAfterDisconnect?(): Promise<void> }>;
}
export type DesktopServiceRequestHandler = (context: DesktopServiceRequestContext) => Promise<unknown>;
