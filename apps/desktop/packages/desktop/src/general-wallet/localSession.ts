import { randomUUID } from "node:crypto";

/** Main owns this port for one actual private window. Authentication never comes from its renderer. */
export function createLocalManagementSession(port: Electron.MessagePortMain, input: {
  isCurrent(): boolean; authenticate(reason: string): Promise<void>; cancelAuthentication(): void;
  authenticationPhase(pending: boolean): void; invalidate?(): void;
}): { dispatch(command: unknown): Promise<unknown>; close(): Promise<void> } {
  let closed = false, closing: Promise<void> | undefined;
  let authenticating: string | undefined;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const send = (type: "command" | "close", command?: unknown): Promise<unknown> => {
    if (closed && type !== "close") return Promise.reject(new Error("GENERAL_OPERATION_CANCELED"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("GENERAL_SETUP_TIMEOUT")); }, type === "close" ? 70_000 : 120_000);
      pending.set(id, { resolve, reject, timer });
      try { port.postMessage({ type, id, ...(type === "command" ? { command } : {}) }); }
      catch { clearTimeout(timer); pending.delete(id); reject(new Error("GENERAL_SETUP_UNAVAILABLE")); }
    });
  };
  const fail = () => {
    closed = true; input.cancelAuthentication();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("GENERAL_SETUP_UNAVAILABLE")); }
    pending.clear(); input.invalidate?.();
  };
  port.on("close", fail);
  port.on("message", (event: Electron.MessageEvent) => {
    const message = event.data;
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if (message.type === "reply" && typeof message.ok === "boolean" && typeof message.id === "string") {
      const item = pending.get(message.id); if (!item) return;
      clearTimeout(item.timer); pending.delete(message.id);
      if (message.ok) item.resolve(message.value);
      else item.reject(new Error(typeof message.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(message.code) ? message.code : "GENERAL_SETUP_UNAVAILABLE"));
      return;
    }
    if (message.type === "authentication-canceled" && authenticating === message.id) { input.cancelAuthentication(); return; }
    if (message.type !== "authenticate" || closed || !input.isCurrent() || authenticating ||
        Object.keys(message).sort().join() !== "id,scope,type" || typeof message.id !== "string" || !/^[0-9a-f-]{36}$/.test(message.id)) return;
    const scope = message.scope;
    if (!scope || typeof scope !== "object" || Object.keys(scope).sort().join() !== "accountAddress,action,operationDigest" ||
        !["initialize_local_wallet", "upgrade_payment_sources", "create_wallet", "import_mnemonic", "import_private_key", "reveal_mnemonic", "export_private_key"].includes(scope.action) ||
        typeof scope.operationDigest !== "string" || !/^[0-9a-f]{64}$/.test(scope.operationDigest) ||
        scope.accountAddress !== null && (typeof scope.accountAddress !== "string" || !/^0x[0-9a-f]{40}$/.test(scope.accountAddress))) return;
    const id = authenticating = message.id;
    try { input.authenticationPhase(true); } catch { fail(); return; }
    void (async () => {
      let ok = false;
      try { await input.authenticate(scope.action); ok = !closed && authenticating === id && input.isCurrent(); }
      catch { /* Only a settled host approval may approve this exact request. */ }
      finally {
        if (authenticating === id) authenticating = undefined;
        if (!closed) {
          try { input.authenticationPhase(false); port.postMessage({ type: "authentication-result", id, digest: scope.operationDigest, ok }); }
          catch { fail(); }
        }
      }
    })();
  });
  port.start();
  return {
    dispatch: (command) => input.isCurrent() ? send("command", command) : Promise.reject(new Error("GENERAL_OPERATION_CANCELED")),
    close: () => {
      if (closing) return closing;
      closed = true; input.cancelAuthentication();
      return closing = send("close").then(() => { fail(); port.close(); });
    },
  };
}
