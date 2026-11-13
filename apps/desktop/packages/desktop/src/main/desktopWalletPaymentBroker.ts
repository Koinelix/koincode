import {
  walletPaymentNoticeSchema,
  walletPaymentClosedSchema,
  type WalletPaymentNotice,
  type WalletPaymentChoice,
  type WalletPaymentView,
} from "@fcode/shared";
import { isWalletMessage } from "./desktopWalletProtocol.js";

type Notice = { value: WalletPaymentNotice; started: number };
/** Read-only presentation correlation. Executable decisions remain in the utility. */
export class DesktopWalletPaymentBroker {
  private readonly notices = new Map<string, Notice>();
  private listener?: () => void;
  private version = 0;
  constructor(
    private readonly send: (value: Record<string, unknown>) => Promise<unknown>,
    private readonly healthy: () => boolean,
    private readonly presenterLost: () => void,
    private readonly now = () => performance.now(),
  ) {}
  available(): boolean {
    return !!this.listener && this.healthy();
  }
  subscribe(listener: () => void): () => void {
    if (this.listener) throw new Error("WALLET_PRESENTER_ALREADY_EXISTS");
    this.listener = listener;
    return () => {
      if (this.listener !== listener) return;
      this.listener = undefined;
      this.invalidate();
      if (this.healthy()) this.presenterLost();
    };
  }
  list(): WalletPaymentView[] {
    if (!this.healthy()) return [];
    return [...this.notices.values()].map(({ value, started }) => {
      const elapsed = this.now() - started;
      return {
        ...structuredClone(value.view),
        expiresInMs:
          !Number.isFinite(elapsed) || elapsed < 0
            ? 0
            : Math.max(0, Math.floor(value.view.expiresInMs - elapsed)),
      };
    });
  }
  receive(raw: unknown): boolean {
    if (!isWalletMessage(raw)) return false;
    if (raw.type === "payment-closed") {
      const closed = walletPaymentClosedSchema.safeParse(raw);
      if (
        closed.success &&
        this.notices.get(closed.data.approvalId)?.value.generation === closed.data.generation
      ) {
        this.notices.delete(closed.data.approvalId);
        this.changed();
      }
      return true;
    }
    if (raw.type !== "payment-request") return false;
    const parsed = walletPaymentNoticeSchema.safeParse(raw);
    if (!parsed.success) return true;
    const notice = parsed.data;
    if (this.notices.has(notice.view.approvalId)) return true;
    if (!this.available() || this.notices.size >= 32) {
      void this.send({
        type: "payment-decision",
        generation: notice.generation,
        approvalId: notice.view.approvalId,
        choice: "deny",
      }).catch(() => {});
      return true;
    }
    if (!this.notices.has(notice.view.approvalId)) {
      this.notices.set(notice.view.approvalId, { value: notice, started: this.now() });
      this.changed();
    }
    return true;
  }
  async decide(approvalId: string, choice: WalletPaymentChoice, authenticated = false): Promise<boolean> {
    await Promise.resolve();
    const notice = this.notices.get(approvalId),
      version = this.version;
    if (!notice || !this.available()) return false;
    const elapsed = this.now() - notice.started;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= notice.value.view.expiresInMs)
      return false;
    const result = await this.send({
      type: "payment-decision",
      generation: notice.value.generation,
      approvalId,
      choice,
      authenticated,
    });
    return result === true && this.healthy() && this.version === version;
  }
  invalidate(): void {
    this.version++;
    this.notices.clear();
    this.changed();
  }
  private changed(): void {
    try {
      const returned: unknown = this.listener?.();
      if (returned !== undefined) {
        void Promise.resolve(returned).catch(() => {});
        throw new Error("WALLET_INVALID_PRESENTER");
      }
    } catch {
      this.listener = undefined;
      this.notices.clear();
      this.version++;
      this.presenterLost();
    }
  }
}
