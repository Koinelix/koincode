import type { RemoteHostConfig } from "./contracts.js";

export function remoteEndpoint(config: Pick<RemoteHostConfig, "host" | "port">): string {
  const address = config.host.includes(":") ? new URL(`ssh://[${config.host}]`).hostname : config.host.toLowerCase();
  return `${address}:${config.port}`;
}
