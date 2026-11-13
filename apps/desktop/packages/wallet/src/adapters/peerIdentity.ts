import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import type { ClientHandle } from "../app/sessions.js";
import {
  recordKernelPeer,
  type PeerIdentityReport,
  type PeerIdentityProof,
} from "../app/peerIdentity.js";
import { requireWallet, WalletError } from "../domain/errors.js";
export async function inspectMacPeer(
  helper: string,
  socket: Socket,
  handle: ClientHandle,
): Promise<PeerIdentityProof> {
  requireWallet(
    process.platform === "darwin" && isAbsolute(helper),
    "CLIENT_IDENTITY_UNAVAILABLE",
    "The native peer helper is unavailable.",
  );
  const info = await lstat(helper),
    fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
  requireWallet(
    info.isFile() &&
      !info.isSymbolicLink() &&
      (info.mode & 0o022) === 0 &&
      Number.isInteger(fd) &&
      fd! >= 0,
    "CLIENT_IDENTITY_UNAVAILABLE",
    "A protected helper and live accepted socket are required.",
  );
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(helper, [], {
      stdio: ["ignore", "pipe", "pipe", fd!],
      env: { PATH: "/usr/bin:/bin" },
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 6000);
    child.stdout?.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16384) child.kill("SIGKILL");
      else chunks.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      reject(new WalletError("CLIENT_IDENTITY_UNAVAILABLE", "Native peer inspection failed."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && size <= 16384) resolve(Buffer.concat(chunks));
      else reject(new WalletError("CLIENT_IDENTITY_UNAVAILABLE", "Native peer inspection failed."));
    });
  });
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(bytes.toString());
  } catch {
    throw new WalletError("CLIENT_IDENTITY_UNAVAILABLE", "Native peer output is invalid.");
  }
  requireWallet(
    raw.kernelBound === true &&
      Number.isInteger(raw.pid) &&
      Number.isInteger(raw.uid) &&
      raw.uid === process.getuid?.() &&
      ["valid", "hardened", "riskyEntitlements", "interpreter"].every(
        (key) => typeof raw[key] === "boolean",
      ) &&
      ["identifier", "team", "requirement"].every(
        (key) => typeof raw[key] === "string" && (raw[key] as string).length <= 8192,
      ),
    "CLIENT_IDENTITY_UNAVAILABLE",
    "The native peer report is invalid.",
  );
  const identityKey =
    raw.valid && raw.identifier && raw.requirement
      ? createHash("sha256")
          .update(
            JSON.stringify([
              raw.identifier,
              raw.team,
              raw.requirement,
              raw.hardened,
              raw.riskyEntitlements,
              raw.interpreter,
            ]),
          )
          .digest("hex")
      : null;
  const report: PeerIdentityReport = {
    platform: "darwin",
    kernelBound: true,
    pid: raw.pid as number,
    uid: raw.uid as number,
    valid: raw.valid as boolean,
    identityKey,
    hardened: raw.hardened as boolean,
    riskyEntitlements: raw.riskyEntitlements as boolean,
    interpreter: raw.interpreter as boolean,
    classification: "token_only",
  };
  return recordKernelPeer(handle, report);
}
