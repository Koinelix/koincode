import { randomUUID } from "node:crypto";
import { LocalGeneralManagement, type LocalManagementAuthentication } from "@koincode/wallet/local-management";

/** A dedicated parent-owned port, absent from ordinary wallet commands and all model-facing ports. */
export function bindLocalGeneralManagement(port: Electron.MessagePortMain, input: {
  directory: string; keychainHelper: string;
  paymentNetwork?: "eip155:8453" | "eip155:84532";
  registerPaymentSource: NonNullable<ConstructorParameters<typeof LocalGeneralManagement>[0]["registerPaymentSource"]>;
  upgradePayments: NonNullable<ConstructorParameters<typeof LocalGeneralManagement>[0]["upgradePayments"]>;
  legacyAccounts: NonNullable<ConstructorParameters<typeof LocalGeneralManagement>[0]["legacyAccounts"]>;
  exportLegacyKey: NonNullable<ConstructorParameters<typeof LocalGeneralManagement>[0]["exportLegacyKey"]>;
  lookupLegacyAddress(address: string): Promise<"match" | "none" | "unavailable">;
}): { close(): Promise<void>; active(): boolean; signAllowance: LocalGeneralManagement["signAllowance"]; preparePayment: LocalGeneralManagement["preparePayment"] } {
  let stopped = false, closing: Promise<void> | undefined, inFlight = 0;
  let authentication: { id: string; digest: string; finish(ok: boolean): void } | undefined;
  const post = (message: unknown) => { try { port.postMessage(message); } catch { void close(); } };
  const authenticate = (scope: LocalManagementAuthentication, signal: AbortSignal): Promise<boolean> => {
    if (stopped || signal.aborted || authentication) return Promise.resolve(false);
    return new Promise((resolve) => {
      const id = randomUUID();
      const finish = (ok: boolean) => {
        clearTimeout(timer); signal.removeEventListener("abort", cancel);
        if (authentication?.id === id) authentication = undefined;
        resolve(ok && !stopped && !signal.aborted);
      };
      const cancel = () => { post({ type: "authentication-canceled", id }); finish(false); };
      const timer = setTimeout(cancel, 65_000);
      authentication = { id, digest: scope.operationDigest, finish };
      signal.addEventListener("abort", cancel, { once: true });
      post({ type: "authenticate", id, scope });
    });
  };
  const manager = new LocalGeneralManagement({ ...input, isCurrent: () => !stopped, authenticate });
  let opening: Promise<void> | undefined;
  const ensureOpen = () => opening ??= manager.open().catch((error) => { opening = undefined; throw error; });
  function close(): Promise<void> {
    if (closing) return closing;
    stopped = true; authentication?.finish(false);
    return closing = (async () => { await manager.close(); await opening?.catch(() => {}); })();
  }
  port.on("close", () => { void close().catch(() => {}); });
  port.on("message", (event: Electron.MessageEvent) => {
    const value = event.data;
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (value.type === "authentication-result") {
      if (Object.keys(value).sort().join() === "digest,id,ok,type" && typeof value.ok === "boolean" &&
          authentication && authentication.id === value.id && authentication.digest === value.digest) authentication.finish(value.ok);
      return;
    }
    if (typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id)) return;
    if (value.type === "close" && Object.keys(value).sort().join() === "id,type") {
      void close().then(() => post({ type: "reply", id: value.id, ok: true, value: null }),
        () => post({ type: "reply", id: value.id, ok: false, code: "GENERAL_SETUP_CLOSE_UNCERTAIN" })); return;
    }
    if (stopped || inFlight >= 2 || value.type !== "command" || Object.keys(value).sort().join() !== "command,id,type") return;
    let bytes = Infinity; try { bytes = Buffer.byteLength(JSON.stringify(value.command)); } catch { /* Refuse non-JSON input. */ }
    if (bytes > 8192) return;
    inFlight++;
    void ensureOpen().then(() => manager.dispatch(value.command)).then(
      (result) => { if (!stopped) post({ type: "reply", id: value.id, ok: true, value: result }); },
      (error: unknown) => {
        const code = error && typeof error === "object" && "code" in error ? error.code : "GENERAL_SETUP_UNAVAILABLE";
        if (!stopped) post({ type: "reply", id: value.id, ok: false, code: typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : "GENERAL_SETUP_UNAVAILABLE" });
      },
    ).finally(() => { inFlight--; }).catch(() => {});
  });
  port.start();
  return { close, active: () => !stopped, signAllowance: async (wallet, tx, signal) => { await ensureOpen(); return manager.signAllowance(wallet, tx, signal); },
    preparePayment: async (intent, signal) => { await ensureOpen(); return manager.preparePayment(intent, signal); } };
}
