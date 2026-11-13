import type { openLocalWalletRequests } from "@koincode/wallet/node";
import type { WalletControlCommand } from "../main/desktopWalletProtocol.js";

type Service = Awaited<ReturnType<typeof openLocalWalletRequests>>;

/** Private utility control only; model data ports never dispatch management commands. */
export function executeWalletManagement(service: Service, command: WalletControlCommand): Promise<unknown> {
  if (command.action === "save_credential") {
    if (Object.keys(command).sort().join(",") !== "action,clientId,headerName,origin,path,value" ||
        typeof command.clientId !== "string" || typeof command.origin !== "string" ||
        typeof command.path !== "string" || typeof command.value !== "string") {
      throw new Error("Invalid credential control.");
    }
    return service.requests.credentials.save({ clientIds: [command.clientId], origin: command.origin,
      path: command.path, headerName: command.headerName, value: command.value }).then((credentialRef) => ({ credentialRef }));
  }
  if (command.action === "revoke_credential") {
    if (Object.keys(command).sort().join(",") !== "action,credentialRef" || typeof command.credentialRef !== "string")
      throw new Error("Invalid credential control.");
    return service.requests.credentials.revoke(command.credentialRef).then(() => null);
  }
  return service.runtime.management.execute(command);
}
