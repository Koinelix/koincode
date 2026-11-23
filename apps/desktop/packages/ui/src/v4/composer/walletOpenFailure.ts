/** Classify only the error actually returned by the host, never request content. */
export function walletOpenFailureMessageId(error: unknown): string {
  const candidate = error && typeof error === "object" && "code" in error ? error.code : error instanceof Error ? error.message : "";
  const text = typeof candidate === "string" ? candidate.slice(0, 4096) : "";
  if (/\b(?:WALLET_NATIVE_BUILD_FAILED|WALLET_RUNTIME_BUILD_FAILED|WALLET_RUNTIME_ASSETS_INCOMPLETE|WALLET_RUNTIME_UNAVAILABLE)\b/.test(text)) return "wallet.openRuntimeFailed";
  if (/\b(?:PROTECTED_STORAGE_UNAVAILABLE|PROTECTED_STORAGE_POLICY_INVALID)\b/.test(text)) return "wallet.openStorageFailed";
  if (/\b(?:WALLET_RECOVERY_REQUIRED|WALLET_STORAGE_RECOVERY_REQUIRED|WALLET_STORAGE_MIGRATION_REQUIRED)\b/.test(text)) return "wallet.openRecoveryRequired";
  return "wallet.openFailed";
}
