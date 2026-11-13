import { LEGACY_ENV_PREFIX } from "../branding-compatibility.js";
import { FCODE_REMOTE_HOST_BROKER_ENV_PREFIX, FCODE_REMOTE_HOST_BROKER_SOCKET_ENV_KEY, FCODE_REMOTE_HOST_BROKER_TOKEN_ENV_KEY, REMOTE_HOST_LIMITS } from "./limits.js";

interface CapturedRemoteHostBrokerCredentials { socket: string; token: string }
let captured: Readonly<CapturedRemoteHostBrokerCredentials> | undefined;
let initialized = false;
let mcpGrants = new WeakMap<object, Readonly<CapturedRemoteHostBrokerCredentials>>();

/** CLI entry captures before sanitizing; only the bundled runtime receives a directed copy. */
export function captureRemoteHostBrokerCredentials(env: Record<string, string | undefined>): void {
  if (initialized) return;
  initialized = true;
  const values = (name: string) => Object.entries(env).filter(([key]) => key.toUpperCase() === name).map(([, value]) => value?.trim());
  const sockets = values(FCODE_REMOTE_HOST_BROKER_SOCKET_ENV_KEY);
  const tokens = values(FCODE_REMOTE_HOST_BROKER_TOKEN_ENV_KEY);
  if (!sockets.length && !tokens.length) return;
  if (new Set(sockets).size !== 1 || new Set(tokens).size !== 1) { captured = undefined; return; }
  const socket = sockets[0]; const token = tokens[0];
  if (!socket || socket.length > REMOTE_HOST_LIMITS.pathBytes || !token || !/^[a-f0-9]{64}$/.test(token)) { captured = undefined; return; }
  captured = Object.freeze({ socket, token });
}

export function getCapturedRemoteHostBrokerCredentials(): CapturedRemoteHostBrokerCredentials | undefined {
  return captured ? { ...captured } : undefined;
}
/** Only bootstrap-created object identities can receive a directed child environment. */
export function registerRemoteHostMcpConfig(config: {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}): boolean {
  if (!captured) return false;
  if (config.args) Object.freeze(config.args);
  if (config.env) Object.freeze(config.env);
  Object.freeze(config);
  mcpGrants.set(config, captured);
  return true;
}

export function getRemoteHostMcpConfigCredentials(config: object): CapturedRemoteHostBrokerCredentials | undefined {
  const grant = mcpGrants.get(config);
  return grant ? { ...grant } : undefined;
}

export function hasRemoteHostMcpConfigGrant(config: object): boolean {
  return mcpGrants.has(config);
}

export function isRemoteHostBrokerEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  const normalized = upper.startsWith(LEGACY_ENV_PREFIX)
    ? `FCODE_${upper.slice(LEGACY_ENV_PREFIX.length)}` : upper;
  return normalized.startsWith(FCODE_REMOTE_HOST_BROKER_ENV_PREFIX);
}

/** Apply after all untrusted overlays; only the first-party MCP boundary may inject a grant. */
export function stripRemoteHostBrokerEnvInPlace(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (isRemoteHostBrokerEnvKey(key)) delete env[key];
  }
}

export function resetCapturedRemoteHostBrokerCredentialsForTest(): void {
  captured = undefined;
  initialized = false;
  mcpGrants = new WeakMap();
}
