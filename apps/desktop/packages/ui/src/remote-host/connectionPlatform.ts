/** This interaction change is Windows-only; the broker remains the capability authority. */
export function shouldPrepareRemoteHostConnection(userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /Windows/i.test(userAgent);
}
