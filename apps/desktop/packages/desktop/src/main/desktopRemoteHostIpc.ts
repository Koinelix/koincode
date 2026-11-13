import { BrowserWindow, ipcMain, dialog } from "electron";
import { randomUUID } from "node:crypto";
import { REMOTE_HOST_IPC_CHANNEL, REMOTE_HOST_LIMITS, RemoteHostError, remoteHostFailure,
  remoteHostManagementRequestSchema, remoteHostManagementSchemas } from "@fcode/shared";
import { DesktopRemoteHostBroker } from "./desktopRemoteHostBroker.js";

export function registerDesktopRemoteHostIpc(options: {
  broker: DesktopRemoteHostBroker; ownsWindow(window: BrowserWindow): boolean;
}): () => void {
  const clients = new Map<number, { id: string; operations: Map<string, { canceled: boolean; dispatched: boolean }> }>();
  const handle = (secretChannel: boolean) => async (event: Electron.IpcMainInvokeEvent, raw: unknown) => {
    const id = randomUUID();
    let releaseOperation: (() => void) | undefined;
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || !options.ownsWindow(window) || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        throw new RemoteHostError("permission_denied", "Remote Host management requires the root FCode window.", "authorization");
      }
      if (Buffer.byteLength(JSON.stringify(raw)) > REMOTE_HOST_LIMITS.ipcBytes) throw new RemoteHostError("transfer_limit", "The management request exceeds its transport budget.");
      const request = remoteHostManagementRequestSchema.parse(raw);
      if ((request.method === "saveHost") !== secretChannel) throw new RemoteHostError("permission_denied", "Credential saves require the confidential management route.", "authorization");
      const input = remoteHostManagementSchemas[request.method].parse(request.input);
      let client = clients.get(window.id);
      if (!client) {
        client = { id: randomUUID(), operations: new Map() }; clients.set(window.id, client);
        const owned = client;
        window.once("closed", () => {
          for (const operation of owned.operations.values()) operation.canceled = true;
          clients.delete(window.id); options.broker.revokeManagementClient(owned.id);
        });
      }
      const clientInstanceId = client.id;
      if (request.method === "cancelManagementOperation") {
        const cancel = remoteHostManagementSchemas.cancelManagementOperation.parse(input);
        const operation = client.operations.get(cancel.operationId);
        if (!operation) return { kind: "reply", id, ok: true, value: { cancelRequested: false } };
        operation.canceled = true;
        const value = operation.dispatched ? await options.broker.request({ kind: "manage", clientInstanceId, windowId: String(window.id), method: request.method, input }) : { cancelRequested: true };
        return { kind: "reply", id, ok: true, value };
      }
      let operation: { canceled: boolean; dispatched: boolean } | undefined;
      if ("operationId" in input && typeof input.operationId === "string") {
        if (client.operations.has(input.operationId)) throw new RemoteHostError("idempotency_conflict", "This management operation is already running.");
        if (client.operations.size >= 16) throw new RemoteHostError("transfer_limit", "Too many management operations are pending in this window.");
        operation = { canceled: false, dispatched: false }; client.operations.set(input.operationId, operation);
        const operations = client.operations; const operationId = input.operationId;
        releaseOperation = () => operations.delete(operationId);
      }
      let selectedPath: string | undefined;
      if (request.method === "chooseUploadSource") {
        const pick = remoteHostManagementSchemas.chooseUploadSource.parse(input);
        const result = await dialog.showOpenDialog(window, { properties: [pick.kind === "directory" ? "openDirectory" : "openFile"] });
        if (result.canceled || !result.filePaths[0]) return { kind: "reply", id, ok: true, value: null };
        selectedPath = result.filePaths[0];
      }
      if (window.isDestroyed() || operation?.canceled) throw new RemoteHostError("canceled", "The management operation was canceled.");
      if (operation) operation.dispatched = true;
      const value = await options.broker.request({ kind: "manage", clientInstanceId, windowId: String(window.id), method: request.method, input,
        ...(selectedPath ? { selectedPath } : {}) });
      return { kind: "reply", id, ok: true, value };
    } catch (error) {
      // Never serialize raw exceptions or request bodies from credential-bearing routes.
      return { kind: "reply", id, ok: false, error: remoteHostFailure(error) };
    } finally { releaseOperation?.(); }
  };
  ipcMain.handle(REMOTE_HOST_IPC_CHANNEL, handle(false));
  ipcMain.handle(`${REMOTE_HOST_IPC_CHANNEL}:secret`, handle(true));
  return () => {
    for (const client of clients.values()) {
      for (const operation of client.operations.values()) operation.canceled = true;
      options.broker.revokeManagementClient(client.id);
    }
    clients.clear(); ipcMain.removeHandler(REMOTE_HOST_IPC_CHANNEL); ipcMain.removeHandler(`${REMOTE_HOST_IPC_CHANNEL}:secret`);
  };
}
