import { requireWallet } from "../domain/errors.js";

/** A local phase deadline never grants authority or extends its parent signal. */
export function requestDeadline(parent: AbortSignal, milliseconds: number,
  clock: { wall(): number; monotonic(): number }) {
  const controller = new AbortController();
  const startedWall = clock.wall(), startedMono = clock.monotonic();
  const signal = AbortSignal.any([parent, controller.signal]);
  const timer = setTimeout(() => controller.abort(), milliseconds);
  timer.unref();
  return {
    signal,
    check() {
      const wall = clock.wall() - startedWall, mono = clock.monotonic() - startedMono;
      if (!Number.isFinite(wall) || !Number.isFinite(mono) || wall < 0 || mono < 0 ||
        wall >= milliseconds || mono >= milliseconds) controller.abort();
      requireWallet(!signal.aborted, "WALLET_OPERATION_ABORTED", "The request phase was canceled or expired.");
    },
    close() { clearTimeout(timer); },
  };
}
