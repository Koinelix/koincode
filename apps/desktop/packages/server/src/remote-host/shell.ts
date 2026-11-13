import type { Client, ClientChannel } from "ssh2";
import { RemoteHostError, REMOTE_HOST_LIMITS,
  type RemoteShellCommand, type RemoteShellResult } from "@fcode/shared";

const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function quoteRemoteShellArgument(value: string): string {
  if (value.includes("\0")) throw new RemoteHostError("invalid_request", "Shell arguments cannot contain NUL.");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function remoteShellScript(input: RemoteShellCommand): string {
  const environment = Object.entries(input.env ?? {}).map(([key, value]) => {
    if (!ENVIRONMENT_KEY.test(key)) throw new RemoteHostError("invalid_request", "Invalid environment variable name.");
    return `${key}=${quoteRemoteShellArgument(value)}`;
  });
  const cwd = input.cwd ? `cd -- ${quoteRemoteShellArgument(input.cwd)} && ` : "";
  return `${cwd}${environment.length ? environment.join(" ") + " " : ""}/bin/sh -c ${quoteRemoteShellArgument(input.command)} < /dev/null`;
}

export function executeRemoteShell(client: Client, input: RemoteShellCommand, options: {
  signal?: AbortSignal;
  onOutput?: (stream: "stdout" | "stderr", bytes: Uint8Array) => void;
  rejectedAsUnavailable?: boolean;
  onStalledClose?: () => void;
}): Promise<RemoteShellResult> {
  options.signal?.throwIfAborted();
  const command = remoteShellScript(input);
  return new Promise((resolve, reject) => {
    let channel: ClientChannel | undefined;
    let done = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const clean = () => {
      clearTimeout(stopTimer);
      options.signal?.removeEventListener("abort", abort);
      client.off("close", lost);
    };
    const fail = (error: unknown) => {
      if (done) return;
      done = true; clean(); reject(error);
    };
    const lost = () => fail(new RemoteHostError("execution_unknown", "The SSH connection closed without a verified command result.", "execution"));
    const closeChannel = (stream: ClientChannel) => {
      if (options.onStalledClose) {
        const timer = setTimeout(options.onStalledClose, REMOTE_HOST_LIMITS.cancelWaitMs + 100);
        timer.unref(); stream.once("close", () => clearTimeout(timer));
      }
      stream.close();
    };
    const abort = () => {
      if (done) return;
      // The server can start exec before its callback arrives. Keep the original
      // stop deadline and signal a late channel instead of assuming no dispatch.
      if (channel) try { channel.signal("TERM"); } catch { /* A close race still requires an unverified result. */ }
      if (!stopTimer) {
        stopTimer = setTimeout(() => {
          if (channel) closeChannel(channel); else options.onStalledClose?.();
          fail(new RemoteHostError("execution_unknown", "Stopping the remote command was not confirmed.", "execution"));
        }, REMOTE_HOST_LIMITS.cancelWaitMs);
        stopTimer.unref();
      }
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    client.once("close", lost);
    client.exec(command, { pty: false }, (error, stream) => {
      if (done) {
        if (stream && options.signal?.aborted) try { stream.signal("TERM"); } catch { /* A late channel remains unverified. */ }
        if (stream) closeChannel(stream); return;
      }
      if (error) return fail(options.rejectedAsUnavailable
        ? new RemoteHostError("capability_unavailable", "The server does not permit this fixed verification command.", "connection")
        : new RemoteHostError("execution_unknown", "The server did not confirm command dispatch.", "execution"));
      channel = stream;
      const output = (kind: "stdout" | "stderr", bytes: Buffer) => {
        try { options.onOutput?.(kind, bytes); }
        catch (failure) { closeChannel(stream); fail(failure); }
      };
      stream.on("data", (bytes: Buffer) => output("stdout", bytes));
      stream.stderr.on("data", (bytes: Buffer) => output("stderr", bytes));
      stream.once("error", () => lost());
      stream.once("close", (code: number | undefined, signal?: string) => {
        if (done) return;
        done = true; clean();
        resolve({ exitCode: typeof code === "number" ? code : null, ...(signal ? { signal } : {}) });
      });
      // Keep the channel writable: ssh2 suppresses signal requests after EOF.
      // The shell wrapper supplies empty stdin without ending this half-channel.
      if (options.signal?.aborted) abort();
    });
  });
}
