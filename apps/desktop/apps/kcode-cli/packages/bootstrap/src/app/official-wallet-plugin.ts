import type { OfficialPluginDefinition } from "./official-plugin-definitions.js";
import { WALLET_HOST_SERVER } from "@fcode/shared";

export const OFFICIAL_WALLET_PLUGIN: OfficialPluginDefinition = {
  name: "koin-wallet", version: "0.2.0", defaultEnabled: true,
  hostMcpServerNames: [WALLET_HOST_SERVER],
  listing: { displayName: "KoinCode Wallet", category: "productivity", author: { name: "KoinCode" } },
  requiredSeedPaths: ["skills/wallet-http/SKILL.md"],
  rootCandidates: ["packages/koin-wallet-plugin", "../koin-wallet-plugin",
    "../../koin-wallet-plugin", "../../../koin-wallet-plugin"],
};
