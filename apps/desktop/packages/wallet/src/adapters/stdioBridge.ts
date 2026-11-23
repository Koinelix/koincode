import { connect } from "node:net";
import { lstat, realpath } from "node:fs/promises";
import type { Duplex, Readable, Writable } from "node:stream";
import { requireWallet, WalletError } from "../domain/errors.js";
import { connectWindowsWalletPipe } from "./windowsPipe.js";
import { configureWindowsNative } from "./windowsNative.js";
// Credentials arrive on a dedicated trusted pipe; argv and inherited environment carry none.
export async function runWalletStdioBridge(input: {
  socketPath: string;
  clientId: string;
  token: string;
  stdin: Readable;
  stdout: Writable;
  nativeHelper?: string;
}): Promise<void> {
  let windows: Awaited<ReturnType<typeof connectWindowsWalletPipe>> | undefined;
  if (process.platform === "win32") {
    if (input.nativeHelper) configureWindowsNative(input.nativeHelper);
    windows = await connectWindowsWalletPipe(input.socketPath);
  }
  if (!windows) {
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
  }
  const socket = windows?.stream ?? connect(input.socketPath);
  let cleanupAuthentication = () => {};
  if (!windows) {
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
  }
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
        cleanupData();
        socket.off("close", fail);
        socket.off("error", fail);
      };
      const cleanupData = () => {
        clearTimeout(timer);
        socket.off("data", data);
      };
      cleanupAuthentication = cleanup;
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
        // Retain terminal listeners until forwarding installs its own observers.
        cleanupData();
        const remaining = buffer.subarray(end + 1);
        if (remaining.length) socket.unshift(remaining);
        resolve();
      };
      socket.on("data", data);
      socket.once("close", fail);
      socket.once("error", fail);
    });
    await forwardStdio(socket, input.stdin, input.stdout, cleanupAuthentication);
  } finally {
    input.stdin.unpipe(socket);
    socket.destroy();
    try { if (windows) await windows.close(); }
    finally { cleanupAuthentication(); }
  }
}

const OUTPUT_DRAIN_MS = 5000;

/** One owner observes terminal state and every output callback it actually submits. */
async function forwardStdio(socket: Duplex, stdin: Readable, stdout: Writable, releaseAuthentication: () => void): Promise<void> {
  let terminal = socket.destroyed, pendingOutput = false, settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveForward!: () => void, rejectForward!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => { resolveForward = resolve; rejectForward = reject; });
  const outputUnavailable = () => new WalletError("LOCAL_TRANSPORT_UNAVAILABLE", "The wallet bridge output did not complete.");
  const releaseOutput = () => {
    if (settled && !pendingOutput) {
      stdout.off("error", outputError);
      stdout.off("close", outputClosed);
    }
  };
  const fail = (error: Error) => {
    if (!settled) { settled = true; rejectForward(error); }
    socket.destroy();
  };
  const outputError = (error: Error) => fail(error);
  const outputClosed = () => { if (pendingOutput) fail(outputUnavailable()); };
  const pump = () => {
    if (settled || pendingOutput) return;
    const bytes = socket.read() as Buffer | null;
    if (bytes !== null) {
      pendingOutput = true;
      try {
        stdout.write(bytes, error => {
          pendingOutput = false;
          if (error) fail(error);
          // Writable emits a callback error before its error event; retain ownership through both.
          setImmediate(releaseOutput);
          if (!settled) pump();
        });
      } catch (error) {
        pendingOutput = false;
        fail(error instanceof Error ? error : outputUnavailable());
      }
    } else if (terminal) {
      if (stdout !== process.stdout && stdout !== process.stderr && !stdout.writableEnded) {
        pendingOutput = true;
        stdout.end((error?: Error | null) => {
          pendingOutput = false;
          if (error) fail(error);
          else { settled = true; resolveForward(); }
          setImmediate(releaseOutput);
        });
      } else { settled = true; resolveForward(); }
    }
  };
  const closed = () => {
    terminal = true;
    if (!settled && !timer) timer = setTimeout(() => fail(outputUnavailable()), OUTPUT_DRAIN_MS);
    pump();
  };
  const endInput = () => socket.end();
  const inputError = () => socket.destroy();
  socket.on("error", fail);
  socket.once("close", closed);
  socket.on("readable", pump);
  stdout.on("error", outputError);
  stdout.once("close", outputClosed);
  stdin.once("end", endInput);
  stdin.once("error", inputError);
  releaseAuthentication();
  try {
    if (socket.errored) fail(socket.errored);
    else if (terminal) closed();
    else { stdin.pipe(socket); pump(); }
    await completion;
  } finally {
    if (timer) clearTimeout(timer);
    stdin.unpipe(socket);
    stdin.off("end", endInput);
    stdin.off("error", inputError);
    socket.off("readable", pump);
    socket.off("close", closed);
    // An errored stream can still have its scheduled error event after completion rejects.
    if (socket.closed) socket.off("error", fail);
    else socket.once("close", () => socket.off("error", fail));
    setImmediate(releaseOutput);
  }
}
