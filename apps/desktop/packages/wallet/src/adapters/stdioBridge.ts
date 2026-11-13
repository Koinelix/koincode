import { connect } from "node:net";
import { lstat, realpath } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { requireWallet, WalletError } from "../domain/errors.js";
// Credentials arrive on a dedicated trusted pipe; argv and inherited environment carry none.
export async function runWalletStdioBridge(input: {
  socketPath: string;
  clientId: string;
  token: string;
  stdin: Readable;
  stdout: Writable;
}): Promise<void> {
  const info = await lstat(input.socketPath);
  requireWallet(
    info.isSocket() &&
      !info.isSymbolicLink() &&
      (info.mode & 0o077) === 0 &&
      info.uid === process.getuid?.() &&
      (await realpath(input.socketPath)) === input.socketPath,
    "UNSAFE_STORAGE_PATH",
    "A private same-user wallet socket is required.",
  );
  const socket = connect(input.socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", () =>
      reject(
        new WalletError(
          "LOCAL_TRANSPORT_UNAVAILABLE",
          "The private wallet service is unavailable.",
        ),
      ),
    );
  });
  try {
    socket.write(JSON.stringify({ clientId: input.clientId, token: input.token }) + "\n");
    await new Promise<void>((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const fail = () => {
        cleanup();
        reject(new WalletError("CLIENT_AUTHENTICATION_REQUIRED", "Client authentication failed."));
      };
      const timer = setTimeout(() => {
        socket.destroy();
        fail();
      }, 5000);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("data", data);
        socket.off("close", fail);
        socket.off("error", fail);
      };
      const data = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 65536) {
          fail();
          return;
        }
        const end = buffer.indexOf(10);
        if (end < 0) return;
        if (buffer.subarray(0, end).toString() !== '{"authenticated":true}') {
          fail();
          return;
        }
        socket.pause();
        cleanup();
        const remaining = buffer.subarray(end + 1);
        if (remaining.length) socket.unshift(remaining);
        resolve();
      };
      socket.on("data", data);
      socket.once("close", fail);
      socket.once("error", fail);
    });
    await new Promise<void>((resolve) => {
      input.stdin.pipe(socket);
      socket.pipe(input.stdout);
      socket.resume();
      socket.once("close", resolve);
      input.stdin.once("end", () => socket.end());
      input.stdin.once("error", () => socket.destroy());
      input.stdout.once("error", () => socket.destroy());
    });
  } finally {
    input.stdin.unpipe(socket);
    socket.unpipe(input.stdout);
    socket.destroy();
  }
}
