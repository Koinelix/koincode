import { createHash } from "node:crypto";
import type { WalletState } from "./state.js";
import { audit } from "./runtimeContext.js";
import { requireWallet } from "../domain/errors.js";

// UUIDv5 is a stable locator, never a bearer secret or proof of caller authority.
const NAMESPACE = Buffer.from("94846e91da564d53b06316878a3a8a3b", "hex");
export function desktopClientId(ownerId: string, epoch: string): string {
  const bytes = createHash("sha1").update(NAMESPACE).update(`${ownerId}:${epoch}:desktop`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Called only inside the existing management queue and protected state transaction. */
export function ensureDesktopClient(state: WalletState): { clientId: string; freshHistory: boolean } {
  const clientId = desktopClientId(state.ownerId, state.managementEpoch);
  const subjectIds = state.wallets.map(wallet => wallet.subjectId);
  requireWallet(subjectIds.length > 0, "WALLET_NOT_FOUND", "Create or restore a wallet before using desktop payments.");
  let client = state.clients.find(item => item.clientId === clientId);
  if (client) {
    requireWallet(client.ownerId === state.ownerId && client.kind === "internal" &&
      client.registrationEpoch === state.managementEpoch, "CLIENT_AUTHENTICATION_REQUIRED", "The desktop client identity is invalid.");
    requireWallet(client.active, "DESKTOP_CLIENT_DISABLED", "Desktop wallet access was disabled by the user.");
    const missing = subjectIds.filter(id => !client!.subjectIds.includes(id));
    if (missing.length) { client.subjectIds.push(...missing); audit(state, "DESKTOP_CLIENT_SCOPE_UPDATED", null, { clientId }); }
  } else {
    client = { clientId, ownerId: state.ownerId, registrationEpoch: state.managementEpoch,
      generation: 1, active: true, kind: "internal", subjectIds };
    state.clients.push(client);
    audit(state, "DESKTOP_CLIENT_CONNECTED", null, { clientId });
  }
  const transport = state.transport;
  const freshHistory = !transport?.journalAnchors?.some(item => item.clientId === clientId) &&
    !transport?.requests.some(item => item.clientId === clientId) &&
    !state.intents.some(item => item.clientId === clientId);
  return { clientId, freshHistory };
}

/** Existing desktop connections follow the managed-wallet set; no other client is expanded. */
export function desktopClientScopeIsStale(state: WalletState): boolean {
  const clientId = desktopClientId(state.ownerId, state.managementEpoch);
  const client = state.clients.find(item => item.clientId === clientId);
  return Boolean(client?.active && client.kind === "internal" && client.ownerId === state.ownerId &&
    client.registrationEpoch === state.managementEpoch && state.wallets.some(wallet => !client.subjectIds.includes(wallet.subjectId)));
}
export function synchronizeDesktopClientScope(state: WalletState): void {
  if (desktopClientScopeIsStale(state)) ensureDesktopClient(state);
}
