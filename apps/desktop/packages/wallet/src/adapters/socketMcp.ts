import { inspectMacPeer } from "./peerIdentity.js";
import { attachWalletConnection, type WalletSocketOptions } from "./socketSession.js";
import { startWindowsWalletPipe } from "./windowsPipe.js";
import { createConnection, createServer, type Server as NetServer } from "node:net";
import type { Duplex } from "node:stream";
import { lstat, realpath, chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { WalletRuntime } from "../app/runtime.js";
import type { WalletRequests } from "../app/requests.js";
import { requireWallet, WalletError } from "../domain/errors.js";
export async function startWalletSocket(
  runtime: WalletRuntime,
  requests: WalletRequests,
  directory: string,
  options: WalletSocketOptions = {},
): Promise<{ path: string; close: () => Promise<void> }> {
  if (process.platform === "win32") return startWindowsWalletPipe(runtime, requests, directory, options);
  const info = await lstat(directory);
  requireWallet(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      (info.mode & 0o077) === 0 &&
      info.uid === process.getuid?.() &&
      (await realpath(directory)) === directory,
    "UNSAFE_STORAGE_PATH",
    "A private canonical socket directory is required.",
  );
  const path = join(directory, "wallet-mcp.sock");
  requireWallet(
    Buffer.byteLength(path) <= 100,
    "UNSAFE_STORAGE_PATH",
    "The local socket path exceeds its native limit.",
  );
  const sockets = new Set<Duplex>();
  await removeStaleSocket(path);
  const paymentStreams = new Set<Promise<void>>();
  const server: NetServer = createServer((socket) => attachWalletConnection(runtime, requests, socket, options,
    { sockets, paymentStreams }, options.peerHelper ? handle => inspectMacPeer(options.peerHelper!, socket, handle) : undefined));
  await new Promise<void>((resolve, reject) => {
    server.once("error", () =>
      reject(
        new WalletError(
          "LOCAL_TRANSPORT_UNAVAILABLE",
          "The private wallet socket could not be opened.",
        ),
      ),
    );
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  return {
    path,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled(paymentStreams);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(path).catch(() => {});
    },
  };
}

async function removeStaleSocket(path: string): Promise<void> {
  let prior;
  try { prior = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  requireWallet(prior.isSocket() && !prior.isSymbolicLink() && prior.uid === process.getuid?.() &&
    (prior.mode & 0o077) === 0, "UNSAFE_STORAGE_PATH", "An existing endpoint is not a private wallet socket.");
  const refused = await new Promise<boolean>(resolve => {
    const probe = createConnection(path);
    const timer = setTimeout(() => { probe.destroy(); resolve(false); }, 500);
    probe.once("connect", () => { clearTimeout(timer); probe.destroy(); resolve(false); });
    probe.once("error", error => { clearTimeout(timer); resolve((error as NodeJS.ErrnoException).code === "ECONNREFUSED"); });
  });
  requireWallet(refused, "LOCAL_TRANSPORT_UNAVAILABLE", "An existing wallet endpoint is live or cannot be verified.");
  const latest = await lstat(path);
  requireWallet(latest.ino === prior.ino && latest.dev === prior.dev && latest.isSocket() &&
    !latest.isSymbolicLink(), "UNSAFE_STORAGE_PATH", "The wallet endpoint changed during stale-socket verification.");
  await unlink(path);
}
