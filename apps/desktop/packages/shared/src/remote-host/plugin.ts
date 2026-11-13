import { REMOTE_HOST_PLUGIN_ID, REMOTE_HOST_PROTOCOL_VERSION } from "./limits.js";

export function isCompatibleRemoteHostPlugin(plugin: { id: string; enabled: boolean; marketplace: string; source: string;
  remoteHostProtocolVersion?: number }): boolean {
  return plugin.id === REMOTE_HOST_PLUGIN_ID && plugin.enabled && plugin.marketplace === "fcode-plugins-official" &&
    (plugin.source === "official" || plugin.source === "cache") && plugin.remoteHostProtocolVersion === REMOTE_HOST_PROTOCOL_VERSION;
}
