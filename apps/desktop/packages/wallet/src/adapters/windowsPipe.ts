import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import type { WalletRuntime } from "../app/runtime.js";
import type { WalletRequests } from "../app/requests.js";
import { recordKernelPeer } from "../app/peerIdentity.js";
import { attachWalletConnection, type WalletSocketOptions } from "./socketSession.js";
import { createPrivateDirectory } from "./privateFilesystem.js";
import { WindowsPipeBroker, type WindowsPipeStream } from "./windowsPipeBroker.js";

export function windowsWalletPipePath(directory: string): string {
  return "\\\\.\\pipe\\KoinCodeWallet-v1-" + createHash("sha256").update(directory.toLowerCase()).digest("hex");
}
export async function startWindowsWalletPipe(runtime: WalletRuntime, requests: WalletRequests,
  directory: string, options: WalletSocketOptions) {
  createPrivateDirectory(directory);
  const path = windowsWalletPipePath(directory);
  const sockets = new Set<Duplex>(), paymentStreams = new Set<Promise<void>>(), pending = new Set<Promise<void>>();
  const broker = new WindowsPipeBroker("server", path, stream => {
    attachWalletConnection(runtime, requests, stream, options, { sockets, paymentStreams, pending }, async handle =>
      recordKernelPeer(handle, { ...stream.peer, kernelBound: true, valid: false, identityKey: null, classification: "token_only" }));
  });
  try { await broker.ready; }
  catch (error) { await broker.close().catch(() => {}); throw error; }
  return { path, close: async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.allSettled(paymentStreams);
    await broker.close();
    while (pending.size) await Promise.allSettled(pending);
  } };
}
export async function connectWindowsWalletPipe(path: string): Promise<{ stream: WindowsPipeStream; close(): Promise<void> }> {
  let stream: WindowsPipeStream | undefined;
  const broker = new WindowsPipeBroker("client", path, opened => { stream = opened; });
  try {
    await broker.ready;
    if (!stream) throw new Error("The native pipe did not return an authenticated peer.");
    return { stream, close: () => broker.close() };
  } catch (error) { await broker.close().catch(() => {}); throw error; }
}
