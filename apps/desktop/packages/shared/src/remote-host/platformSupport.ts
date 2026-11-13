export type RemoteHostExecutionUnavailableReason = "windows_private_ipc_unavailable" | "platform_unverified";

/** Windows x64 uses the verified private ACL listener; other Windows ABIs remain unavailable. */
export function remoteHostExecutionSupport(platform: string, arch: string = process.arch): { available: boolean; unavailableReason?: RemoteHostExecutionUnavailableReason } {
  if (platform === "darwin") return { available: true };
  if (platform === "win32" && arch === "x64") return { available: true };
  return { available: false, unavailableReason: platform === "win32" ? "windows_private_ipc_unavailable" : "platform_unverified" };
}
