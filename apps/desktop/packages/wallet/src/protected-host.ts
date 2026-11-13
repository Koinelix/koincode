import { createRequire } from "node:module";
import { GeneralNativeTransport, type GeneralNativeTransportPort } from "./adapters/generalNativeTransport.js";
import { GeneralSessionChannel, type GeneralSessionInput, type GeneralSessionResponse } from "./adapters/generalSessionChannel.js";
import { WalletError } from "./domain/errors.js";
import type { GeneralProtectedSqlPort } from "./adapters/generalProtectedRepositories.js";
export { openProtectedPaymentOwnerConnection, type ProtectedPaymentOwnerConnection } from "./adapters/generalPaymentOwnerTransport.js";

const ADDON = "/Library/KoinCodeProtectedWallet/WalletHost.app/Contents/Resources/native/general-protection-bridge.node";
let opened = false;
type ResourceKind = "profiles_root" | "profile_directory" | "history_directory" | "state_repository" | "signing_repository";
type NativeHost = GeneralNativeTransportPort & {
  readonly identity: Readonly<{ uid: number; installationId: string; installationRevision: number }>;
  materializeResource(kind: ResourceKind): void;
  repository(kind: "state" | "signing"): GeneralProtectedSqlPort;
};
/** Physical native connection only. Opening/importing never implies a ready
 * wallet, an authenticated operation, access to a source or payment authority. */
export interface ProtectedHostConnection {
  readonly mode: "manager" | "inspection";
  /** Actual native bootstrap metadata only, never initialization or source authority. */
  readonly identity: Readonly<{ uid: number; installationId: string; installationRevision: number }>;
  readonly ready: Promise<string>;
  assertCurrent(): void;
  onInvalidated(callback: () => void): () => void;
  bindWindow(handle: Buffer, windowId: number, window: object, contents: object, session: object): void;
  /** Requires the native original prepare/start acknowledgements; kind is no creation authority. */
  materializeResource(kind: ResourceKind): void;
  /** One original native port, available only after actual same-pair commit acknowledgement. */
  repository(kind: "state" | "signing"): GeneralProtectedSqlPort;
  request(input: GeneralSessionInput, expiresAt: number, value?: Uint8Array): Promise<GeneralSessionResponse>;
  close(): Promise<void>;
}
/** Fixed independent Host only. There are no injection, fallback, path, fd,
 * receipt or authenticated-boolean parameters. Genuine native module loading
 * verifies the actual original bootstrap before publishing its wrapped owner. */
export function openProtectedHostConnection(): ProtectedHostConnection {
  if (opened || process.platform !== "darwin") throw new WalletError("GENERAL_PROTECTION_UNAVAILABLE", "The protected wallet host is unavailable.");
  opened = true;
  const loaded = createRequire(import.meta.url)(ADDON) as { host: NativeHost };
  const native = loaded.host;
  if (!native || !["manager", "inspection"].includes(native.mode)) throw new WalletError("GENERAL_PROTECTION_UNAVAILABLE", "The protected wallet host is unavailable.");
  native.assertCurrent();
  const identity = native.identity;
  if (!identity || Object.keys(identity).sort().join() !== "installationId,installationRevision,uid" ||
      !Number.isSafeInteger(identity.uid) || identity.uid <= 0 || identity.uid >= 0xffffffff ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(identity.installationId) ||
      !Number.isSafeInteger(identity.installationRevision) || identity.installationRevision < 1)
    throw new WalletError("GENERAL_PROTECTION_UNAVAILABLE", "The actual native installation is unavailable.");
  const transport = new GeneralNativeTransport(native), controller = new AbortController();
  const channel = new GeneralSessionChannel(transport, { assertCurrent: () => transport.assertCurrent(), invalidate: () => controller.abort() }, controller.signal);
  let closing: Promise<void> | undefined;
  return Object.freeze({ mode: native.mode, identity: Object.freeze({ ...identity }), ready: channel.ready,
    assertCurrent: () => transport.assertCurrent(), onInvalidated: (callback: () => void) => transport.onInvalidated(callback),
    bindWindow: (handle: Buffer, windowId: number, window: object, contents: object, session: object) => transport.bindWindow(handle, windowId, window, contents, session),
    materializeResource: (kind: ResourceKind) => { transport.assertCurrent(); native.materializeResource(kind); },
    repository: (kind: "state" | "signing") => { transport.assertCurrent(); return native.repository(kind); },
    request: (input: GeneralSessionInput, expiresAt: number, value?: Uint8Array) => channel.request(input, expiresAt, value),
    close: () => {
      closing ??= (async () => { controller.abort(); await channel.disposeTransport(); await transport.drained; })(); return closing;
    } });
}
