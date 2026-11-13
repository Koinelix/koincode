import type { FCodePluginDiagnostic } from "@fcode/shared";

export function shouldShowRemoteHostSeedDiagnostic(options: {
  diagnostics: readonly FCodePluginDiagnostic[];
  pluginStoreMatchesTarget: boolean;
  isRemoteSyncContext: boolean;
}): boolean {
  return !options.isRemoteSyncContext && options.pluginStoreMatchesTarget &&
    options.diagnostics.some((item) => item.code === "plugin_remote_host_seed_unverified");
}
