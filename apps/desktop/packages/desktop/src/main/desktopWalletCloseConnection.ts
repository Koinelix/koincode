import type { Connection } from "./desktopWalletHostTypes.js";

/** Main retains the map and close promise; this executes its existing close sequence. */
export function closeWalletConnection(
  connection: Connection,
  connections: Map<string, Connection>,
  disconnectHost: (id: string) => Promise<void>,
): Promise<void> {
  if (connection.processEnded) return Promise.resolve();
  if (connection.closing) return connection.closing;
  connection.closed = true;
  connection.client?.close();
  connection.closing = (async () => {
    await connection.ready.catch(() => undefined);
    connection.client?.close();
    if (!connection.processEnded) await disconnectHost(connection.id);
    for (const [key, value] of connections)
      if (value === connection) connections.delete(key);
  })();
  return connection.closing;
}
