export const walletModule = {
  id: "wallet",
  requires: [],
  provides: ["wallet-core"],
  publicEntrypoints: ["contract.ts", "node.ts", "host.ts", "general.ts", "general-receive.ts", "protected-host.ts", "local-management.ts"],
} as const;
