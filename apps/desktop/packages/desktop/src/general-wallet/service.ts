import { parseGeneralWalletRequest } from "../main/desktopGeneralWalletProtocol.js";
import { GENERAL_NETWORKS, GeneralBalanceService, generalTokens } from "@koincode/wallet/general";
import { createGeneralReceiveView } from "@koincode/wallet/general-receive";

interface Port {
  start(): void;
  close(): void;
  once(event: "close", listener: () => void): unknown;
}
interface Event { data: unknown; ports?: Port[] }
interface Parent {
  on(event: "message", listener: (event: Event) => void): unknown;
  postMessage(message: unknown): void;
}

/** Initial read-only utility shell. Sensitive operations are deliberately unavailable. */
export function startGeneralWalletUtility(parent: Parent, terminate: () => void, balances = new GeneralBalanceService()): void {
  let lifetime: Port | undefined;
  let stopped = false;
  const reads = new Map<string, AbortController>();
  const finish = () => {
    if (stopped) return;
    stopped = true;
    for (const controller of reads.values()) controller.abort();
    reads.clear();
    balances.close();
    try { lifetime?.close(); } catch { /* parent already closed */ }
    terminate();
  };
  const reply = (message: unknown) => {
    if (stopped) return;
    try { parent.postMessage(message); } catch { finish(); }
  };
  parent.on("message", (event) => {
    const ports = event.ports ?? [];
    const request = parseGeneralWalletRequest(event.data);
    if (!request || stopped || (request.type === "start" ? lifetime !== undefined || ports.length !== 1 : ports.length !== 0)) {
      for (const port of ports) { try { port.close(); } catch { /* rejected port */ } }
      finish();
      return;
    }
    if (request.type === "start") {
      const port = ports[0]!;
      lifetime = port;
      try { port.once("close", finish); port.start(); }
      catch { finish(); return; }
      reply({ type: "reply", id: request.id, ok: true, value: null });
      return;
    }
    if (!lifetime) { finish(); return; }
    if (request.type === "cancel") { reads.get(request.id)?.abort(); return; }
    if (request.type === "status") {
      reply({ type: "reply", id: request.id, ok: true, value: {
        state: "unavailable", secretAdmission: "unverified", reason: "GENERAL_IMPLEMENTATION_INCOMPLETE",
      } });
    } else if (request.type === "networks") {
      reply({ type: "reply", id: request.id, ok: true, value: GENERAL_NETWORKS.map((network) => ({
        ...network, balanceRead: "pending_verification", nativeTransfer: "disabled", erc20Transfer: "disabled",
        tokens: generalTokens(network.id),
        ...(network.id === "eip155:84532" ? { transferReason: "legacy_network_reserved" } : {}),
      })) });
    } else if (request.type === "receive") {
      try {
        reply({ type: "reply", id: request.id, ok: true, value: createGeneralReceiveView(request) });
      } catch {
        reply({ type: "reply", id: request.id, ok: false, code: "GENERAL_RECEIVE_UNAVAILABLE" });
      }
    } else if (request.type === "probe_rpc") {
      if (reads.has(request.id)) { finish(); return; }
      const controller = new AbortController();
      reads.set(request.id, controller);
      void balances.probeRpc(request.networkId, request.rpcChoice, controller.signal).then(
        (value) => reply({ type: "reply", id: request.id, ok: true, value }),
        (error: unknown) => {
          const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
            && /^[A-Z][A-Z0-9_]{0,60}$/.test(error.code) ? `GENERAL_${error.code}` : "GENERAL_BALANCE_UNAVAILABLE";
          reply({ type: "reply", id: request.id, ok: false, code });
        },
      ).finally(() => { if (reads.get(request.id) === controller) reads.delete(request.id); });
    } else if (request.type === "custom_balances") {
      if (reads.has(request.id)) { finish(); return; }
      const controller = new AbortController();
      reads.set(request.id, controller);
      void balances.read({ networkId: request.networkId, address: request.address, cacheScope: request.cacheScope,
        assets: request.assets.map((asset) => ({ kind: "erc20" as const, ...asset })), signal: controller.signal, rpcChoice: request.rpcChoice }).then(
        (value) => reply({ type: "reply", id: request.id, ok: true, value }),
        (error: unknown) => {
          const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
            && /^[A-Z][A-Z0-9_]{0,60}$/.test(error.code) ? `GENERAL_${error.code}` : "GENERAL_BALANCE_UNAVAILABLE";
          reply({ type: "reply", id: request.id, ok: false, code });
        },
      ).finally(() => { if (reads.get(request.id) === controller) reads.delete(request.id); });
    } else if (request.type === "inspect_token") {
      if (reads.has(request.id)) { finish(); return; }
      const controller = new AbortController();
      reads.set(request.id, controller);
      void balances.inspectToken({ networkId: request.networkId, address: request.address, contractAddress: request.contractAddress,
        signal: controller.signal, rpcChoice: request.rpcChoice }).then(
        (value) => reply({ type: "reply", id: request.id, ok: true, value }),
        (error: unknown) => {
          const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
            && /^[A-Z][A-Z0-9_]{0,60}$/.test(error.code) ? `GENERAL_${error.code}` : "GENERAL_TOKEN_INSPECTION_UNAVAILABLE";
          reply({ type: "reply", id: request.id, ok: false, code });
        },
      ).finally(() => { if (reads.get(request.id) === controller) reads.delete(request.id); });
    } else {
      if (reads.has(request.id)) { finish(); return; }
      const controller = new AbortController();
      reads.set(request.id, controller);
      const tokens = generalTokens(request.networkId);
      void balances.read({ networkId: request.networkId, address: request.address, cacheScope: request.cacheScope, rpcChoice: request.rpcChoice,
        assets: [{ kind: "native" }, ...tokens.map((token) => ({ kind: "erc20" as const, contractAddress: token.address, expectedDecimals: token.decimals }))],
        signal: controller.signal }).then(
        (value) => reply({ type: "reply", id: request.id, ok: true, value }),
        (error: unknown) => {
          const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
            && /^[A-Z][A-Z0-9_]{0,60}$/.test(error.code) ? `GENERAL_${error.code}` : "GENERAL_BALANCE_UNAVAILABLE";
          reply({ type: "reply", id: request.id, ok: false, code });
        },
      ).finally(() => { if (reads.get(request.id) === controller) reads.delete(request.id); });
    }
  });
}
