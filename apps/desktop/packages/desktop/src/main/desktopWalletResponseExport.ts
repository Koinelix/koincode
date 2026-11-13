import type { WalletResponseDestination } from "./desktopWalletResponseDestination.js";

/** Preserve completed request facts when local saving is cancelled or unavailable. */
export async function attachWalletResponseDestination(value: unknown, toolName: string, signal: AbortSignal,
  choose: ((requestId: string, signal: AbortSignal) => Promise<WalletResponseDestination | undefined>) | undefined,
  approve: ((requestId: string, directory: string, name: string) => Promise<string>) | undefined,
  assertCurrent: () => void): Promise<void> {
  if (!choose || !approve || !["x402_request", "x402_get_request", "x402_recover_response"].includes(toolName) ||
    !value || typeof value !== "object") return;
  const view = value as Record<string, unknown>;
  if (view.transportStatus !== "completed" || typeof view.requestId !== "string" ||
    view.bodyRef !== `wallet-response://requests/${view.requestId}/body` || view.sensitiveRedacted === true ||
    typeof view.httpStatus !== "number" || view.httpStatus < 200 || view.httpStatus >= 300) return;
  try {
    assertCurrent();
    const selected = await choose(view.requestId, signal);
    assertCurrent();
    if (!selected) { Object.assign(view, { responseExport: "canceled" }); return; }
    const destinationRef = await approve(view.requestId, selected.directory, selected.name);
    assertCurrent();
    Object.assign(view, { responseDestination: { destinationRef, responsePath: selected.responsePath, outputBasePath: selected.outputBasePath } });
  } catch { Object.assign(view, { responseExport: "unavailable" }); }
}
