import { dialog, type BrowserWindow } from "electron";
import { DesktopWalletInteraction } from "./desktopWalletInteraction.js";
import { OUTBOUND_CAPACITY, OUTBOUND_PAGE_UNITS, OUTBOUND_TTL_MS, OUTBOUND_OPERATION_TTL_MS, type WalletOutboundRequest } from "./desktopWalletOutboundProtocol.js";
import type { DesktopWalletWindowOptions } from "./desktopWalletWindowPolicy.js";

type Options = {
  host: DesktopWalletWindowOptions;
  current(): BrowserWindow | undefined;
  epoch(): number;
  assertCurrent(window: BrowserWindow, epoch: number): void;
  show(): Promise<void>;
  invalidate(): void;
  messages(): Promise<Record<string, string>>;
  busy: Map<BrowserWindow, string>;
  observations: Map<BrowserWindow, DesktopWalletInteraction>;
  interruptGeneralConfirmation?: () => void;
};

/** Native per-operation consent; executable outbound permissions stay in the utility. */
export function attachWalletOutboundDialogs(options: Options): () => void {
  const broker = options.host.outboundBroker;
  if (!broker) return () => {};
  let disposed = false;
  let queue = Promise.resolve();
  let active: AbortController | undefined;
  let queued = 0;

  async function present(notice: WalletOutboundRequest, end: number): Promise<void> {
    try { options.interruptGeneralConfirmation?.(); } catch { /* Keep the original presenter independent. */ }
    const pending = () => !disposed && performance.now() < end && broker!.pending(notice.approvalId);
    if (!pending()) return;
    await options.show();
    const win = options.current();
    if (!win || win.isDestroyed()) return;
    const epoch = options.epoch();
    const assertCurrent = () => {
      options.assertCurrent(win, epoch);
      if (!pending()) throw new Error("OUTBOUND_APPROVAL_UNAVAILABLE");
    };
    // Only an active request waits; a preceding payment ACK can still own the shared gate.
    while (options.busy.size) {
      assertCurrent();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assertCurrent();
    options.busy.set(win, "outbound_approval");
    const controller = new AbortController();
    active = controller;
    const observation = new DesktopWalletInteraction(() => {
      try { options.assertCurrent(win, epoch); return true; } catch { return false; }
    }, options.invalidate);
    options.observations.set(win, observation);
    void observation.canceled.catch(() => controller.abort());
    const interval = setInterval(() => { if (!pending()) controller.abort(); }, 100);
    const timeout = setTimeout(() => controller.abort(), Math.max(1, end - performance.now()));
    interval.unref(); timeout.unref();
    try {
      const text = await options.messages();
      const label = (key: string): string => {
        const value = text[key];
        if (typeof value !== "string" || !value || value.length > 2048) throw new Error("WALLET_UNAVAILABLE");
        return value;
      };
      assertCurrent();
      let offset = 0;
      for (;;) {
        const raw = await broker!.inspect(notice.approvalId, offset);
        assertCurrent();
        controller.signal.throwIfAborted();
        if (!raw || typeof raw !== "object") throw new Error("OUTBOUND_APPROVAL_UNAVAILABLE");
        const page = raw as Record<string, unknown>;
        if (page.offset !== offset || typeof page.text !== "string" || page.text.length > OUTBOUND_PAGE_UNITS ||
            page.nextOffset !== offset + page.text.length || page.totalUnits !== notice.inspectionUnits ||
            (page.nextOffset as number) > notice.inspectionUnits ||
            (!page.text.length && offset !== notice.inspectionUnits)) throw new Error("WALLET_INVALID_RESPONSE");
        const last = page.nextOffset === notice.inspectionUnits;
        const response = await dialog.showMessageBox(win, {
          type: "question", title: label("outboundTitle"),
          message: `${label("outboundMessage")}\n${notice.method} ${notice.url}`,
          detail: `${label("outboundNotice")}\n${label("outboundStage")}: ${label(`outboundStage_${notice.context.stage}`)}\n` +
            `${label("outboundClient")}: ${notice.client.clientId}\n${label("outboundSession")}: ${notice.client.sessionId}\n` +
            `${label("paymentOperation")}: ${notice.context.operationId} / ${notice.context.requestId}\n` +
            `${label("outboundPage")}: ${offset}–${page.nextOffset} / ${notice.inspectionUnits}\n\n${page.text}`,
          buttons: [label("outboundDeny"), label(last ? "outboundAllow" : "outboundNext")],
          defaultId: 0, cancelId: 0, noLink: true, signal: controller.signal,
        });
        assertCurrent();
        controller.signal.throwIfAborted();
        if (response.response !== 1) { await broker!.decide(notice.approvalId, false, 1); return; }
        if (last) {
          const duration = OUTBOUND_OPERATION_TTL_MS;
          // False can mean the accepted stage already completed or expired before its ACK.
          // The original request reports the outcome; do not retry or claim it was never sent.
          await broker!.decide(notice.approvalId, true, duration);
          return;
        }
        offset = page.nextOffset as number;
      }
    } finally {
      clearInterval(interval); clearTimeout(timeout);
      observation.stop();
      if (options.observations.get(win) === observation) options.observations.delete(win);
      options.busy.delete(win);
      if (active === controller) active = undefined;
    }
  }

  const unsubscribe = broker.subscribe((notice) => {
    try { options.interruptGeneralConfirmation?.(); } catch { /* Keep the original presenter independent. */ }
    if (disposed || queued >= OUTBOUND_CAPACITY) {
      void broker.decide(notice.approvalId, false, 1).catch(() => {});
      return;
    }
    queued++;
    const end = performance.now() + OUTBOUND_TTL_MS;
    queue = queue.then(() => present(notice, end)).catch(async () => {
      try { await broker.decide(notice.approvalId, false, 1); } catch { /* Loss never grants consent. */ }
    }).finally(() => { queued--; });
  });
  return () => { disposed = true; active?.abort(); unsubscribe(); };
}
