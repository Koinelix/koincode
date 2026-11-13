import { localUserStorageMigration } from "@koincode/wallet/local-management";
import * as walletNode from "@koincode/wallet/node";
import { desktopPaymentNetwork } from "./paymentNetwork.js";
import { WalletHostRequestPorts } from "./hostRequestPorts.js";
import { WalletExternalPayments } from "./externalPayments.js";
import { WalletOutboundApprovals } from "./outboundApprovals.js";
import { WalletPaymentPrompts, unlockPaymentWallet } from "./paymentPrompts.js";
import { executeWalletManagement } from "./management.js";
import { isAbsolute, basename, dirname, join } from "node:path";
import { bindLocalGeneralManagement } from "./generalManagement.js";
import {
  isWalletMessage,
  parseAllowanceCommand, type WalletControlCommand,
  type WalletStartMode,
} from "../main/desktopWalletProtocol.js";

type WalletParent = {
  postMessage(value: unknown): void;
  on(event: "message", listener: (event: Electron.MessageEvent) => void): unknown;
};
type OpenRequests = typeof walletNode.openLocalWalletRequests;
/** Shared original wallet business owner. Alternate launch transports do not
 * change grants, budgets, serialization, payment checks or request recovery. */
export function startWalletService(parent: WalletParent, options: {
  terminate?(code: number): void;
  openRequests?: OpenRequests;
  fixedKeychainHelper?: string;
} = {}): void {
const paymentNetwork = desktopPaymentNetwork();
const terminate = options.terminate ?? ((code: number) => process.exit(code));
type Service = Awaited<ReturnType<typeof walletNode.openLocalWalletRequests>>;
type Runtime = Service["runtime"];
const outbound = new WalletOutboundApprovals((message) => parent.postMessage(message));
let runtime: Runtime | undefined;
let service: Service | undefined;
let hostPorts: WalletHostRequestPorts | undefined;
const payments: WalletPaymentPrompts = new WalletPaymentPrompts((message) => parent.postMessage(message),
  (connectionId, approvalId, choice, signal) => {
    const decision = externalPayments.decide(connectionId, approvalId, choice, signal);
    if (decision) return decision;
    if (!hostPorts) throw new Error("PAYMENT_APPROVAL_UNAVAILABLE");
    return hostPorts.decidePayment(connectionId, approvalId, choice, signal);
  }, async (walletId, signal, authenticated) => {
    if (!runtime) throw new Error("WALLET_NOT_OPEN");
    const result = await unlockPaymentWallet(runtime, walletId, signal, authenticated);
    service?.requests.modelRecovery.resume();
    return result;
  });
const externalPayments: WalletExternalPayments = new WalletExternalPayments((id, view, signal) => payments.presenter(id)(view, signal), paymentNetwork.namespace);
let opening: Promise<Runtime> | undefined;
let stopping = false;
let stoppingPromise: Promise<void> | undefined;
let terminating = false;
let lifetimePort: Electron.MessagePortMain | undefined;
let lockGeneration = 0;
let management: ReturnType<typeof bindLocalGeneralManagement> | undefined;
let nativeHelper: string | undefined;
let maintenanceMode = false;
let maintenance: Promise<unknown> | undefined;
let migrationPlan: Extract<Awaited<ReturnType<typeof localUserStorageMigration>>, { status: "planned" }>["plan"] | undefined;

function closePorts(ports: Electron.MessagePortMain[]): void {
  for (const port of ports) {
    try {
      port.close();
    } catch {
      /* Rejected transferred ports never authorize startup. */
    }
  }
}

function codeOf(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
  )
    return error.code;
  return "WALLET_UNAVAILABLE";
}

function lockNow(): void {
  lockGeneration++;
  migrationPlan = undefined;
  outbound.invalidate();
  payments.invalidate();
  runtime?.lockForHostEvent();
  void management?.close().catch(() => {});
}

async function start(
  mode: WalletStartMode,
  keychainHelper: string,
  ports: Electron.MessagePortMain[],
): Promise<void> {
  if (
    opening ||
    runtime ||
    stopping ||
    lifetimePort ||
    !isAbsolute(keychainHelper) ||
    ports.length !== 1
  ) {
    closePorts(ports);
    throw new Error("Invalid wallet start.");
  }
  lifetimePort = ports[0]!;
  lifetimePort.once("close", terminateService);
  lifetimePort.start();
  if (stopping) throw new Error("The wallet is stopping.");
  if (mode === "storage_maintenance") {
    maintenanceMode = true; nativeHelper = options.fixedKeychainHelper ?? keychainHelper; return;
  }
  const generation = lockGeneration;
  opening = (options.openRequests ?? walletNode.openLocalWalletRequests)({
    namespace: paymentNetwork.namespace,
    localBaseSepoliaTest: paymentNetwork.network === "eip155:84532",
    mode,
    keychainHelper: options.fixedKeychainHelper ?? keychainHelper,
    generalAllowance: async (wallet, tx, signal, open) => {
      if (management?.active()) return management.signAllowance(wallet, tx, signal);
      await management?.close(); return open();
    },
    generalPayment: async (intent, signal, open) => {
      if (management?.active()) return management.preparePayment(intent, signal);
      await management?.close(); return open();
    },
    authorize: outbound.authorize,
    checkOutbound: outbound.checkOutbound,
  }).then((opened) => { service = opened; return opened.runtime; });
  try {
    const opened = await opening;
    opened.useSystemProtection();
    runtime = opened;
    nativeHelper = options.fixedKeychainHelper ?? keychainHelper;
    if (service) await externalPayments.start(service);
    if (stopping || generation !== lockGeneration) opened.lockForHostEvent();
    if (stopping) throw new Error("The wallet is stopping.");
  } finally {
    opening = undefined;
  }
}

function stop(): Promise<void> {
  if (stoppingPromise) return stoppingPromise;
  stopping = true;
  outbound.dispose();
  payments.dispose();
  // The async body runs synchronously through lockNow before its first await.
  stoppingPromise = (async () => {
    lockNow();
    try {
      await maintenance?.catch(() => {});
      const opened = runtime ?? (opening ? await opening.catch(() => undefined) : undefined);
      if (opened) {
        opened.lockForHostEvent();
        await management?.close();
        await externalPayments.close();
        try { await hostPorts?.close(); } finally { await opened.close(); }
      }
    } finally {
      runtime = undefined;
      service = undefined;
      hostPorts = undefined;
    }
  })();
  return stoppingPromise;
}

function terminateService(): void {
  if (terminating) return;
  terminating = true;
  const deadline = setTimeout(() => terminate(1), 5000);
  const finish = (code: number) => {
    clearTimeout(deadline);
    terminate(code);
  };
  void stop().then(
    () => finish(0),
    () => finish(1),
  );
}

function reply(value: unknown): void {
  // A pending open or command may settle after the parent connection was lost.
  if (terminating) return;
  try {
    parent.postMessage(value);
  } catch {
    terminateService();
  }
}

const allowedActions = new Set([
  "save_credential",
  "revoke_credential",
  "create",
  "default",
  "resume_signing",
  "limits",
  "register_client",
  "revoke_client",
  "revoke_grant",
  "unlock",
  "lock",
]);
parent.on("message", (event: Electron.MessageEvent) => {
  const value: unknown = event.data;
  const ports = event.ports ?? [];
  if (!isWalletMessage(value) || (ports.length > 0 && value.type !== "start" && value.type !== "host-connect" && value.type !== "general-connect")) {
    closePorts(ports);
    return;
  }
  if (value.type === "lock-event") {
    lockNow();
    return;
  }
  if (value.type === "interaction-event") {
    lockGeneration++;
    outbound.invalidate(); payments.invalidate();
    runtime?.cancelHostInteraction();
    return;
  }
  if (typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id)) {
    closePorts(ports);
    return;
  }
  const id = value.id;
  void (async () => {
    if (value.type === "stop") {
      await stop();
      return null;
    }
    if (stopping) {
      closePorts(ports);
      throw new Error("The wallet is stopping.");
    }
    if (value.type === "start") {
      if (
        !(value.mode === "open" || value.mode === "create" || value.mode === "resume_setup" || value.mode === "import_setup" || value.mode === "storage_maintenance") ||
        typeof value.keychainHelper !== "string"
      ) {
        closePorts(ports);
        throw new Error("Invalid wallet start.");
      }
      await start(value.mode, value.keychainHelper, ports);
      return null;
    }
    if (value.type === "storage-plan" || value.type === "storage-apply") {
      if (!maintenanceMode || !nativeHelper || maintenance || ports.length ||
          Object.keys(value).sort().join() !== (value.type === "storage-plan" ? "id,type" : "id,token,type"))
        throw new Error("Invalid storage maintenance request.");
      if (value.type === "storage-apply" && (!migrationPlan || value.token !== migrationPlan.generation))
        throw new Error("Invalid storage migration approval.");
      const execute = value.type === "storage-apply";
      const generation = lockGeneration;
      let sequence = 0;
      maintenance = localUserStorageMigration(dirname(nativeHelper), paymentNetwork.namespace, execute ? migrationPlan : undefined,
        () => reply({ type: "storage-progress", id: value.id, sequence: ++sequence }),
        () => { if (stopping || terminating || generation !== lockGeneration)
          throw Object.assign(new Error("Storage maintenance canceled."), { code: "WALLET_INTERACTION_CANCELED" }); });
      try {
        const result = await maintenance as Awaited<ReturnType<typeof localUserStorageMigration>>;
        if (result.status === "planned") {
          migrationPlan = result.plan;
          return { token: result.plan.generation, records: result.plan.entries.length,
            domains: new Set(result.plan.entries.map(e => e.namespace)).size };
        }
        migrationPlan = undefined; return { status: "active" };
      } finally { maintenance = undefined; }
    }
    if (!runtime || opening) {
      closePorts(ports);
      throw new Error("The wallet is not open.");
    }
    if (value.type === "general-connect") {
      if (Object.keys(value).sort().join() !== "id,type" || ports.length !== 1 || !nativeHelper || !service)
        throw new Error("Invalid local management connection.");
      await management?.close();
      management = bindLocalGeneralManagement(ports[0]!, {
        paymentNetwork: paymentNetwork.network,
        directory: join(dirname(walletNode.walletServiceDirectory(paymentNetwork.namespace)), "general-local"),
        keychainHelper: join(dirname(nativeHelper), basename(dirname(nativeHelper)) === "user-v2" ? "keychain-helper-general-wallet" : "noninteractive-v1/keychain-helper-general-wallet"),
        lookupLegacyAddress: async (address) => runtime?.lookupManagedAddress(address) ?? "unavailable",
        legacyAccounts: () => runtime!.listLocalManagementAccounts(),
        registerPaymentSource: (key, signal) => runtime!.registerLocalPaymentSource(key, signal),
        upgradePayments: (authenticate, signal) => runtime!.upgradeLocalPaymentSources((operationDigest, currentSignal) =>
          authenticate({ action: "upgrade_payment_sources", operationDigest, accountAddress: null }, currentSignal), signal),
        exportLegacyKey: (id, authenticate, signal) => runtime!.revealLocalManagementKey(id,
          (binding, currentSignal) => authenticate({ action: "export_private_key", operationDigest: binding.operationDigest,
            accountAddress: binding.address }, currentSignal), signal),
      });
      return null;
    }
    if (value.type === "host-connect") {
      const expected = ["chatId", "clientId", "id", "mode", "type", ...(value.connectionId === undefined ? [] : ["connectionId"]), ...(value.paymentUi === undefined ? [] : ["paymentUi"]), ...(value.hostGrantScope === undefined ? [] : ["hostGrantScope"])].sort().join(",");
      if (ports.length !== 1 || !service ||
        Object.keys(value).sort().join(",") !== expected ||
        (value.connectionId !== undefined && (typeof value.connectionId !== "string" || !/^[0-9a-f-]{36}$/.test(value.connectionId))) ||
        (value.paymentUi !== undefined && (value.paymentUi !== true || typeof value.connectionId !== "string")) ||
        (value.hostGrantScope !== undefined && (typeof value.hostGrantScope !== "string" || !/^[0-9a-f]{64}$/.test(value.hostGrantScope))) ||
        typeof value.clientId !== "string" || typeof value.chatId !== "string" ||
        (value.mode !== "create" && value.mode !== "open")) {
        closePorts(ports);
        throw new Error("Invalid host wallet connection.");
      }
      hostPorts ??= new WalletHostRequestPorts(new walletNode.HostWalletConnections(
        service.runtime, service.requests, service.directory,
      ));
      await hostPorts.bind(ports[0]!, value.clientId, value.chatId, value.mode, value.connectionId as string | undefined,
        value.paymentUi === true ? payments.presenter(value.connectionId as string) : undefined, value.hostGrantScope as string | undefined);
      return null;
    }
    if (value.type === "desktop-connect") {
      if (Object.keys(value).sort().join(",") !== "id,type" || !service) throw new Error("Invalid desktop connection.");
      hostPorts ??= new WalletHostRequestPorts(new walletNode.HostWalletConnections(service.runtime, service.requests, service.directory));
      return hostPorts.prepareDesktopClient();
    }
    if (value.type === "host-disconnect") {
      if (Object.keys(value).sort().join(",") !== "connectionId,id,type" ||
        typeof value.connectionId !== "string" || !/^[0-9a-f-]{36}$/.test(value.connectionId))
        throw new Error("Invalid host wallet disconnection.");
      await hostPorts?.disconnect(value.connectionId);
      return null;
    }
    if (value.type === "host-approve-destination") {
      if (Object.keys(value).sort().join(",") !== "connectionId,directory,id,name,requestId,type" || !hostPorts ||
        typeof value.connectionId !== "string" || !/^[0-9a-f-]{36}$/.test(value.connectionId) ||
        typeof value.requestId !== "string" || !/^[0-9a-f-]{36}$/.test(value.requestId) ||
        typeof value.directory !== "string" || !isAbsolute(value.directory) || value.directory.length > 4096 ||
        typeof value.name !== "string" || !value.name || value.name.length > 200)
        throw new Error("Invalid host output approval.");
      return hostPorts.approveDestination(value.connectionId, value.requestId, value.directory, value.name);
    }
    if (value.type === "payment-decision") {
      if (Object.keys(value).sort().join(",") !== ["approvalId", "choice", "generation", "id", "type", ...(value.authenticated === undefined ? [] : ["authenticated"])].sort().join(",")) throw new Error("Invalid payment decision.");
      return payments.decide({ type: value.type, approvalId: value.approvalId, generation: value.generation, choice: value.choice, ...(value.authenticated === undefined ? {} : { authenticated: value.authenticated }) });
    }
    if (value.type === "outbound-clear") {
      outbound.invalidate();
      return { admissionStopped: true, inFlight: "unknown" };
    }
    if (value.type === "outbound-decision") return outbound.decide(value);
    if (value.type === "outbound-inspect") {
      if (
        typeof value.approvalId !== "string" ||
        typeof value.generation !== "string" ||
        typeof value.offset !== "number"
      )
        throw new Error("Invalid outbound inspection.");
      return outbound.inspect(value.approvalId, value.generation, value.offset);
    }
    if (value.type === "outbound-revoke") {
      if (
        typeof value.clientId !== "string" ||
        !value.clientId ||
        typeof value.operationId !== "string" ||
        !value.operationId
      )
        throw new Error("Invalid outbound revocation.");
      outbound.revoke(value.clientId, value.operationId);
      return { admissionStopped: true, inFlight: "unknown" };
    }
    if (value.type === "list") return runtime.listForDisplay();
    if (value.type === "inspect-wallet" || value.type === "inspect-wallet-display") {
      if (Object.keys(value).sort().join(",") !== "id,offset,section,type,walletId" ||
        typeof value.walletId !== "string" || value.walletId.length > 100 ||
        !["clients", "grants", "payments"].includes(String(value.section)) ||
        !Number.isSafeInteger(value.offset) || (value.offset as number) < 0)
        throw new Error("Invalid wallet inspection.");
      if (value.type === "inspect-wallet" && value.section === "payments" && value.offset === 0) service?.requests.modelRecovery.resume();
      return runtime.inspectWallet(value.walletId, value.section as "clients" | "grants" | "payments", value.offset as number);
    }
    if (value.type === "wallet-allowance") {
      const cmd = parseAllowanceCommand(value.command);
      if (!cmd || !service) throw new Error("WALLET_INVALID_REQUEST");
      const allowance = service.requests.allowance;
      if (cmd.action === "allowance_confirm") return allowance.confirm(cmd.walletId, cmd.previewId);
      if (cmd.action === "allowance_resend") return allowance.resend(cmd.walletId, cmd.hash);
      return allowance.inspect(cmd.walletId, cmd.action === "allowance_preview" ? cmd.amount : undefined);
    }
    if (value.type === "manage") {
      if (
        !isWalletMessage(value.command) ||
        typeof value.command.action !== "string" ||
        !allowedActions.has(value.command.action)
      )
        throw new Error("Invalid wallet command.");
      if (value.command.action === "create" && value.command.network !== paymentNetwork.network)
        throw new Error("The requested network differs from the fixed payment network.");
      if (!service) throw new Error("The wallet is not open.");
      return executeWalletManagement(service, value.command as WalletControlCommand);
    }
    throw new Error("Invalid wallet message.");
  })().then(
    (result) => reply({ id, type: "reply", ok: true, value: result }),
    (error: unknown) => {
      if (value.type === "host-connect" || value.type === "general-connect") closePorts(ports);
      reply({ id, type: "reply", ok: false, code: codeOf(error) });
    },
  );
});
process.once("SIGTERM", terminateService);
process.once("exit", () => {
  outbound.dispose();
  payments.dispose();
  if (lifetimePort) closePorts([lifetimePort]);
});

}
