import { safeStorage } from "electron";
import { randomBytes } from "node:crypto";
import { RemoteHostError, remoteSecretEnvelopeSchema, type RemoteBrokerSecretRequest } from "@fcode/shared";

function protectionStatus(): { available: boolean; backend: string; reason?: string } {
  if (process.platform !== "darwin" && process.platform !== "win32") return { available: false, backend: "unavailable", reason: "This platform supports session credentials only." };
  if (!safeStorage.isEncryptionAvailable()) return { available: false, backend: "unavailable", reason: "System-protected storage is locked or unavailable." };
  try {
    const probe = randomBytes(32).toString("base64");
    if (safeStorage.decryptString(safeStorage.encryptString(probe)) !== probe) throw new Error("Protection probe mismatch");
    return { available: true, backend: process.platform === "darwin" ? "keychain" : "dpapi" };
  } catch { return { available: false, backend: "unavailable", reason: "The system protection round trip failed." }; }
}

/** Called exclusively for requests from the broker utility process, never from a Renderer or Agent. */
export function handleRemoteHostSecretRequest(request: RemoteBrokerSecretRequest): unknown {
  const status = protectionStatus();
  if (request.operation === "status") return status;
  if (!status.available) throw new RemoteHostError("secure_store_unavailable", "System-protected credential storage is unavailable.", "storage");
  try {
    if (request.operation === "seal") return safeStorage.encryptString(JSON.stringify(remoteSecretEnvelopeSchema.parse(request.payload))).toString("base64");
    if (typeof request.payload !== "string" || request.payload.length > 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(request.payload)) {
      throw new RemoteHostError("credential_corrupt", "The protected credential encoding is invalid.", "storage");
    }
    return remoteSecretEnvelopeSchema.parse(JSON.parse(safeStorage.decryptString(Buffer.from(request.payload, "base64"))));
  } catch { throw new RemoteHostError("credential_locked", "The credential could not be protected or unlocked. Re-enter it or use a session credential.", "storage"); }
}
