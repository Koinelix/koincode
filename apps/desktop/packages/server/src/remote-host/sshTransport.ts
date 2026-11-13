import ssh2, { Client, type ConnectConfig, type AuthenticationType, type AnyAuthMethod, type ServerHostKeyAlgorithm } from "ssh2";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  REMOTE_HOST_LIMITS, RemoteHostError,
  type RemoteSshConnectInput, type RemoteSshConnection, type RemoteSshTransportPort,
} from "@fcode/shared";
import { executeRemoteShell } from "./shell.js";
import { RemoteSftpAdapter } from "./sftp.js";
import { RemoteHashProbe } from "./hash.js";

const HOST_KEY_ALGORITHMS: ServerHostKeyAlgorithm[] = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "rsa-sha2-512", "rsa-sha2-256"];
const PASSWORD_PROMPT = /^\s*(?:([A-Za-z0-9_.@-]+)'s )?password\s*:\s*$/i;
const OTHER_AUTHENTICATION_FACTOR = /\b(?:otp|token|verification|sudo|mfa|2fa)\b|\b(?:one|two|multi)[\s_-]?(?:time|factor)\b/i;

function hostKeyAlgorithms(preferred?: string): ServerHostKeyAlgorithm[] {
  if (!preferred) return HOST_KEY_ALGORITHMS;
  if (preferred === "ssh-rsa") return ["rsa-sha2-512", "rsa-sha2-256"];
  const algorithm = HOST_KEY_ALGORITHMS.find((candidate) => candidate === preferred);
  if (!algorithm) {
    throw new RemoteHostError("capability_unavailable", "The saved host key algorithm is not supported.", "trust");
  }
  return [algorithm];
}

function serverIdentity(key: Buffer): { publicKey: string; keyType: string; fingerprint: string } {
  if (key.length < 4) throw new RemoteHostError("host_key_changed", "The server returned an invalid host key.", "trust");
  const typeBytes = key.readUInt32BE(0);
  if (typeBytes <= 0 || typeBytes > key.length - 4) throw new RemoteHostError("host_key_changed", "The server host key is malformed.", "trust");
  return { publicKey: key.toString("base64"), keyType: key.subarray(4, 4 + typeBytes).toString("ascii"),
    fingerprint: `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}` };
}

async function privateKey(path: string, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []; const buffer = Buffer.allocUnsafe(64 * 1024);
  const invalid = () => new RemoteHostError("credential_corrupt", "Select one unchanged regular private key within the supported size limit.", "authentication");
  try {
    signal?.throwIfAborted(); const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > REMOTE_HOST_LIMITS.privateKeyBytes) throw invalid();
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev || info.size > REMOTE_HOST_LIMITS.privateKeyBytes) throw invalid();
      let bytes = 0;
      while (bytes <= REMOTE_HOST_LIMITS.privateKeyBytes) {
        signal?.throwIfAborted();
        const read = await file.read(buffer, 0, Math.min(buffer.length, REMOTE_HOST_LIMITS.privateKeyBytes + 1 - bytes), null);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
        if (bytes > REMOTE_HOST_LIMITS.privateKeyBytes) throw invalid();
        chunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)));
      }
      const after = await file.stat(); signal?.throwIfAborted();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino || after.dev !== info.dev || bytes !== info.size) throw invalid();
      return Buffer.concat(chunks, bytes);
    } finally { await file.close(); }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof RemoteHostError) throw error;
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (["ENOENT", "EACCES", "EPERM"].includes(code)) throw new RemoteHostError("credential_missing", "Select a readable private key file before connecting.", "authentication");
    throw invalid();
  } finally { buffer.fill(0); for (const chunk of chunks) chunk.fill(0); }
}

function connectionFailure(error: unknown): RemoteHostError {
  if (error instanceof RemoteHostError) return error;
  const level = typeof error === "object" && error !== null && "level" in error ? String(error.level) : "";
  if (level === "client-authentication") return new RemoteHostError("authentication_failed", "SSH authentication failed for the selected method.", "authentication");
  if (level === "client-timeout") return new RemoteHostError("connection_timeout", "The SSH handshake timed out.", "connection", true);
  return new RemoteHostError("connection_failed", "The SSH connection could not be established.", "connection", true);
}

export class RemoteSshTransport implements RemoteSshTransportPort {
  constructor(private readonly createClient: () => Client = () => new Client()) {}

  connect(input: RemoteSshConnectInput): Promise<RemoteSshConnection> {
    input.signal?.throwIfAborted();
    if (!input.host.config.enabled) return Promise.reject(new RemoteHostError("host_disabled", "The remote host is disabled."));
    const client = this.createClient();
    const algorithms = hostKeyAlgorithms(input.preferredHostKeyType);
    let verified = false;
    let closed = false;
    let ready = false;
    let pendingSftp = 0;
    let failure: RemoteHostError | undefined;
    let openedKey: Buffer | undefined;
    const attempts = new Set<string>();
    const config = input.host.config;
    return new Promise((resolve, reject) => {
      const release = () => { openedKey?.fill(0); openedKey = undefined; input.signal?.removeEventListener("abort", abort); };
      const fail = (error: unknown) => {
        if (closed) return;
        closed = true;
        failure = connectionFailure(error);
        release(); client.destroy();
        if (!ready) reject(failure);
      };
      const abort = () => fail(new RemoteHostError("canceled", "The SSH connection was canceled.", "connection"));
      client.on("error", (error) => fail(failure ?? error));
      client.on("close", () => {
        if (!ready && !closed) fail(failure ?? new RemoteHostError("connection_failed", "SSH closed during authentication.", "connection"));
        closed = true;
      });
      client.once("ready", () => {
        if (closed || input.signal?.aborted || !verified) return fail(new RemoteHostError("canceled", "The SSH connection is no longer authorized.", "connection"));
        ready = true; release();
        const assertLive = () => {
          if (closed) throw new RemoteHostError("connection_failed", "The SSH connection is closed.", "connection");
        };
        const stalledChannel = () => fail(new RemoteHostError("connection_timeout", "The SSH peer did not acknowledge channel cleanup.", "connection"));
        const hash = new RemoteHashProbe((command, options) => { assertLive(); return executeRemoteShell(client, command, { ...options, rejectedAsUnavailable: true, onStalledClose: stalledChannel }); }, assertLive);
        resolve({
          isAlive: () => !closed,
          onClose: (listener) => {
            client.once("close", listener);
            if (closed) listener();
            return () => { client.off("close", listener); };
          },
          files: async () => {
            assertLive();
            if (pendingSftp >= REMOTE_HOST_LIMITS.globalConcurrency) throw new RemoteHostError("storage_busy", "Too many SFTP channels are awaiting setup.", "connection");
            pendingSftp++;
            return new Promise((resolveFiles, rejectFiles) => {
              let expired = false; let settled = false;
              const finish = () => {
                if (settled) return; settled = true; pendingSftp--; clearTimeout(timer); client.off("close", closedSetup);
              };
              const closedSetup = () => { finish(); rejectFiles(new RemoteHostError("connection_failed", "SSH closed while opening SFTP.", "connection")); };
              const timer = setTimeout(() => {
                expired = true; finish();
                rejectFiles(new RemoteHostError("connection_timeout", "The SFTP channel did not open before its deadline.", "connection"));
                fail(new RemoteHostError("connection_timeout", "The SSH peer did not complete SFTP channel setup.", "connection"));
              }, REMOTE_HOST_LIMITS.handshakeMs);
              timer.unref(); client.once("close", closedSetup);
              try { client.sftp((error, sftp) => {
                finish();
                if (expired || closed) { sftp?.destroy(); rejectFiles(new RemoteHostError("connection_failed", "The SSH connection is closed.", "connection")); }
                else if (error) rejectFiles(new RemoteHostError("capability_unavailable", "The remote server does not provide SFTP.", "connection"));
                else resolveFiles(new RemoteSftpAdapter(sftp, hash.sha256.bind(hash), stalledChannel));
              }); } catch (error) { finish(); rejectFiles(error); }
            });
          },
          exec: (command, options) => { assertLive(); return executeRemoteShell(client, command, { ...options, onStalledClose: stalledChannel }); },
          // All successful SFTP handles have acknowledged CLOSE. Cancellation must
          // also release a stalled peer instead of waiting forever for disconnect.
          close: () => { if (!closed) { closed = true; release(); client.end(); client.destroy(); } },
        });
      });
      const authenticate = async (allowed: AuthenticationType[] | null, partial: boolean, next: (method: AuthenticationType | AnyAuthMethod) => void) => {
        if (closed) return;
        if (!verified) throw new RemoteHostError("permission_denied", "Host identity must be verified before credentials are accessed.", "trust");
        if (partial) throw new RemoteHostError("interactive_auth_required", "The server requires an additional interactive authentication factor.", "authentication");
        const accepts = (name: AuthenticationType) => !allowed || allowed.includes(name);
        const credential = await input.getCredential();
        input.signal?.throwIfAborted();
        if (closed) return;
        if (config.authType === "password" && !attempts.has("password") && accepts("password")) {
          if (!credential.password) throw new RemoteHostError("credential_missing", "Enter a password for this connection.", "authentication");
          attempts.add("password"); next({ type: "password", username: config.username, password: credential.password }); return;
        }
        if (config.authType === "password" && !attempts.has("keyboard-interactive") && accepts("keyboard-interactive")) {
          attempts.add("keyboard-interactive");
          next({ type: "keyboard-interactive", username: config.username, prompt(name, instructions, _lang, prompts, finish) {
            const text = prompts[0]?.prompt ?? ""; const password = PASSWORD_PROMPT.exec(text);
            if (!credential.password || prompts.length !== 1 || prompts[0]?.echo || !password ||
              password[1] !== undefined && password[1] !== config.username || OTHER_AUTHENTICATION_FACTOR.test([name, instructions, text].join("\n"))) {
              finish([]); fail(new RemoteHostError("interactive_auth_required", "Handle the server's interactive authentication manually.", "authentication")); return;
            }
            finish([credential.password]);
          } }); return;
        }
        if (config.authType === "private_key" && !attempts.has("publickey") && accepts("publickey")) {
          attempts.add("publickey");
          if (!config.privateKeyPath) throw new RemoteHostError("credential_missing", "Select a private key for this connection.", "authentication");
          openedKey = await privateKey(config.privateKeyPath, input.signal);
          if (closed || input.signal?.aborted) { release(); return; }
          const parsed = ssh2.utils.parseKey(openedKey, credential.passphrase);
          if (parsed instanceof Error) {
            if (!credential.passphrase && /^Encrypted .*key detected, but no passphrase given$/i.test(parsed.message)) {
              throw new RemoteHostError("credential_missing", "Enter the passphrase for this encrypted private key.", "authentication");
            }
            if (credential.passphrase && /bad passphrase|decrypt|integrity check/i.test(parsed.message)) {
              throw new RemoteHostError("authentication_failed", "The selected private key could not be unlocked with its passphrase.", "authentication");
            }
            throw new RemoteHostError("credential_corrupt", "The selected file does not contain one supported private key.", "authentication");
          }
          if (!parsed.isPrivateKey()) throw new RemoteHostError("credential_corrupt", "Select a private key instead of a public key.", "authentication");
          next({ type: "publickey", username: config.username, key: parsed }); return;
        }
        if (config.authType === "ssh_agent" && !attempts.has("agent") && accepts("publickey")) {
          attempts.add("agent");
          const agent = config.agentPath || process.env.SSH_AUTH_SOCK;
          if (!agent) throw new RemoteHostError("credential_missing", "No SSH agent is available for the explicitly selected agent method.", "authentication");
          next({ type: "agent", username: config.username, agent }); return;
        }
        throw new RemoteHostError("authentication_failed", "The server did not accept the selected authentication method.", "authentication");
      };
      const connectConfig: ConnectConfig = {
        host: config.host, port: config.port, username: config.username,
        readyTimeout: REMOTE_HOST_LIMITS.handshakeMs,
        keepaliveInterval: REMOTE_HOST_LIMITS.keepaliveMs, keepaliveCountMax: REMOTE_HOST_LIMITS.keepaliveFailures,
        algorithms: { serverHostKey: algorithms },
        hostVerifier: (key: Buffer) => {
          try { input.verifyHostKey(serverIdentity(key)); verified = true; return true; }
          catch (error) { failure = connectionFailure(error); return false; }
        },
        authHandler: (methods, partial, next) => { void authenticate(Array.isArray(methods) ? methods : null, partial, next).catch(fail); },
      };
      input.signal?.addEventListener("abort", abort, { once: true });
      try { client.connect(connectConfig); } catch (error) { fail(error); }
    });
  }
}
