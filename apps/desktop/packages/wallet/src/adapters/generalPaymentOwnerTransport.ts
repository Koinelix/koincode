import { createRequire } from "node:module";
import { WalletError, requireWallet } from "../domain/errors.js";
const ADDON = "/Library/KoinCodeProtectedWallet/WalletHost.app/Contents/Resources/native/general-payment-owner-bridge.node";
type Native = {
  readonly identity: Readonly<{ uid: number; installationId: string; installationRevision: number }>;
  assertCurrent(): void;
  readPacket(): Promise<Buffer>;
  writePacket(frame: Buffer): Promise<void>;
  invalidate(): void;
  close(): "closed" | "busy" | "uncertain";
};
export interface ProtectedPaymentOwnerConnection {
  readonly identity: Native["identity"];
  assertCurrent(): void;
  readPacket(): Promise<Buffer>;
  writePacket(frame: Buffer): Promise<void>;
  invalidate(): void;
  close(): Promise<void>;
}
let opened = false;
/** Fixed signed owner entry only. Public packets do not confer any protected
 * source, grant or management authority; original wallet code owns those facts. */
export function openProtectedPaymentOwnerConnection(): ProtectedPaymentOwnerConnection {
  requireWallet(process.platform === "darwin" && !opened, "GENERAL_PAYMENT_OWNER_UNAVAILABLE", "The fixed payment owner is unavailable."); opened = true;
  const native = (createRequire(import.meta.url)(ADDON) as { owner: Native }).owner;
  native.assertCurrent(); const identity = native.identity;
  requireWallet(identity && Object.keys(identity).sort().join() === "installationId,installationRevision,uid" &&
    Number.isSafeInteger(identity.uid) && identity.uid > 0 && identity.uid < 0xffffffff &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(identity.installationId) &&
    Number.isSafeInteger(identity.installationRevision) && identity.installationRevision > 0,
  "GENERAL_PAYMENT_OWNER_UNAVAILABLE", "The actual installation is unavailable.");
  const active = new Set<Promise<unknown>>(); let stopped = false, closing: Promise<void> | undefined;
  const current = () => { requireWallet(!stopped, "GENERAL_PAYMENT_OWNER_UNAVAILABLE", "The original payment owner is closed."); native.assertCurrent(); };
  const track = <T>(work: Promise<T>): Promise<T> => { active.add(work); void work.finally(() => active.delete(work)).catch(() => {}); return work; };
  return Object.freeze({ identity: Object.freeze({ ...identity }), assertCurrent: current,
    readPacket: () => { current(); return track(native.readPacket()); },
    writePacket: (frame: Buffer) => { current(); return track(native.writePacket(frame)); },
    invalidate: () => { stopped = true; native.invalidate(); },
    close: () => {
      if (closing) return closing;
      stopped = true;
      closing = (async () => {
        native.invalidate(); await Promise.allSettled(active);
        if (native.close() !== "closed") throw new WalletError("GENERAL_REGISTRATION_UNCERTAIN", "The original payment owner has not safely drained.");
      })(); return closing;
    },
  });
}
