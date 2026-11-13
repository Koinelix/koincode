import type { OfficialPluginDefinition } from "./official-plugin-definitions.js";
import { REMOTE_HOST_MCP_SERVER } from "@fcode/shared";

/** Ship the content with the broker so first use never depends on a marketplace download. */
export const OFFICIAL_REMOTE_HOST_PLUGIN: OfficialPluginDefinition = {
  defaultEnabled: true,
  hostMcpServerNames: [REMOTE_HOST_MCP_SERVER],
  listing: {
    author: { name: "KoinCode" },
    category: "developer-tools",
    displayName: "Remote Host",
  },
  name: "remote-host",
  requiredSeedPaths: ["skills/remote-host-operations/SKILL.md"],
  rootCandidates: [
    "packages/remote-host-plugin",
    "../remote-host-plugin",
    "../../remote-host-plugin",
    "../../../remote-host-plugin",
  ],
  version: "1.1.2",
};
