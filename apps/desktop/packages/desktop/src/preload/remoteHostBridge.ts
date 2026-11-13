import { ipcRenderer } from "electron";
import { REMOTE_HOST_IPC_CHANNEL, RemoteHostError, remoteBrokerReplySchema, remoteHostManagementSchemas,
  type RemoteHostManagementClient, type RemoteHostManagementMethod, type RemoteHostManagementInput,
  type RemoteHostManagementOutput } from "@fcode/shared";

export const remoteHostBridge: RemoteHostManagementClient = {
  async request<M extends RemoteHostManagementMethod>(method: M, input: RemoteHostManagementInput<M>): Promise<RemoteHostManagementOutput[M]> {
    const normalized = remoteHostManagementSchemas[method].parse(input);
    const reply = remoteBrokerReplySchema.parse(await ipcRenderer.invoke(
      method === "saveHost" ? `${REMOTE_HOST_IPC_CHANNEL}:secret` : REMOTE_HOST_IPC_CHANNEL, { method, input: normalized }));
    if (!reply.ok) throw new RemoteHostError(reply.error.code, reply.error.message, reply.error.stage);
    return reply.value as RemoteHostManagementOutput[M];
  },
};
