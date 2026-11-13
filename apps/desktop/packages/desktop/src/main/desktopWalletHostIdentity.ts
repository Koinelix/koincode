import type { WalletHostAgent } from "@fcode/shared";

export const failure = (code: string) => Object.assign(new Error(code), { code });
export const sameAgent = (a: WalletHostAgent, b: WalletHostAgent) =>
  a.workspaceKey === b.workspaceKey && a.identity === b.identity && a.generation === b.generation;
export const codeOf = (error: unknown): string => {
  const value = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : "WALLET_REQUEST_FAILED";
};
export function assertWalletCurrent(closed: boolean, epoch: number, expectedEpoch: number,
  binding: unknown, expectedBinding: unknown, hostCurrent: boolean, signal?: AbortSignal): void {
  if (closed || epoch !== expectedEpoch || binding !== expectedBinding || !hostCurrent || signal?.aborted)
    throw failure("CLIENT_AUTHENTICATION_REQUIRED");
}
